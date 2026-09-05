import express from 'express';
import cors from 'cors';
import multer from 'multer';
import Razorpay from 'razorpay';
import dotenv from 'dotenv';
import { fal } from '@fal-ai/client';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import axios from 'axios';
import * as cheerio from 'cheerio';

dotenv.config();

// FAL Key Configuration
fal.config({
    credentials: process.env.FAL_KEY
});

const app = express();

// ==========================================
// 🌐 0. CORS & 50MB PAYLOAD CONFIGURATION
// ==========================================
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const JWT_SECRET = process.env.JWT_SECRET || "fitout_ai_auth_key_2026";
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ==========================================
// 🗄️ 1. ZERO-DEPENDENCY DATABASE
// ==========================================
const DB_FILE = './database.json';

if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], generations: [], transactions: [] }, null, 2));
}

function readDB() {
    try {
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    } catch {
        return { users: [], generations: [], transactions: [] };
    }
}

function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_SECRET
});

// ==========================================
// 🛠️ HELPER FUNCTIONS FOR FAL UPLOAD & AI
// ==========================================
async function uploadToFal(imageInput) {
    if (!imageInput) return null;
    if (typeof imageInput === 'string' && imageInput.startsWith('http')) {
        return imageInput;
    }
    
    let base64Data = imageInput;
    let contentType = 'image/jpeg';
    
    if (imageInput.includes(';base64,')) {
        const parts = imageInput.split(';base64,');
        contentType = parts[0].split(':')[1] || 'image/jpeg';
        base64Data = parts[1];
    }
    
    const buffer = Buffer.from(base64Data, 'base64');
    const blob = new Blob([buffer], { type: contentType });
    return await fal.storage.upload(blob);
}

async function fetchImageAsBlob(url) {
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': 'image/*,*/*'
        }
    });
    if (!res.ok) throw new Error(`External image fetch failed: ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    return new Blob([arrayBuffer], { type: contentType });
}

// ======================================================================
// 🛍️ 2. DUAL-ENGINE E-COMMERCE IMAGE EXTRACTOR (FLIPKART/MEESHO/AMAZON)
// ======================================================================
app.post('/api/extract-image', async (req, res) => {
    let { url } = req.body;
    if (!url) return res.status(400).json({ success: false, message: 'URL is required' });

    try {
        url = decodeURIComponent(url).trim();
        if (url.startsWith('//')) url = 'https:' + url;

        // 1. अगर डायरेक्ट इमेज URL है
        if (url.match(/\.(jpeg|jpg|png|webp|avif)($|\?)/i)) {
            return res.json({ success: true, imageUrl: url });
        }

        let extractedImage = null;

        const isValidProductImage = (img) => {
            if (!img || typeof img !== 'string') return false;
            const lower = img.toLowerCase();
            // ब्लॉक लिस्ट: लोगो, सुरक्षा पेजेस और SVG
            if (lower.endsWith('.svg') || 
                lower.includes('logo') || 
                lower.includes('akamai') || 
                lower.includes('captcha') || 
                lower.includes('challenge') ||
                lower.includes('placeholder')) {
                return false;
            }
            return true;
        };

        // 2. इंजन A: Cheerio Scraping
        try {
            const scrapeRes = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Cache-Control': 'no-cache'
                },
                maxRedirects: 5,
                timeout: 9000
            });

            const $ = cheerio.load(scrapeRes.data);

            // Schema.org JSON-LD (सबसे सुरक्षित तरीका)
            $('script[type="application/ld+json"]').each((_, el) => {
                try {
                    const json = JSON.parse($(el).html());
                    const img = json.image || (json['@graph'] && json['@graph'].find(item => item.image)?.image);
                    if (img) {
                        const candidate = Array.isArray(img) ? img[0] : (typeof img === 'object' ? img.url : img);
                        if (isValidProductImage(candidate)) extractedImage = candidate;
                    }
                } catch (e) {}
            });

            // OpenGraph Meta
            if (!extractedImage) {
                const og = $('meta[property="og:image"]').attr('content') || 
                           $('meta[name="twitter:image"]').attr('content');
                if (isValidProductImage(og)) extractedImage = og;
            }

            // ई-कॉमर्स CDN इमेज टैग्स
            if (!extractedImage) {
                $('img').each((_, el) => {
                    const src = $(el).attr('src') || $(el).attr('data-src');
                    if (isValidProductImage(src) && (
                        src.includes('rukminim') || 
                        src.includes('images.meesho.com') || 
                        src.includes('media-amazon.com')
                    )) {
                        extractedImage = src;
                        return false; // लूप रोकें
                    }
                });
            }
        } catch (scrapeErr) {
            console.warn("Direct scraping failed/blocked:", scrapeErr.message);
        }

        // 3. इंजन B: Microlink Fallback
        if (!extractedImage) {
            try {
                const metaRes = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(url)}&filter=image`);
                const metaData = await metaRes.json();
                const fallbackImg = metaData?.data?.image?.url;
                if (isValidProductImage(fallbackImg)) {
                    extractedImage = fallbackImg;
                }
            } catch (fallbackErr) {
                console.warn("Microlink fallback error:", fallbackErr.message);
            }
        }

        if (extractedImage) {
            if (extractedImage.startsWith('//')) extractedImage = 'https:' + extractedImage;
            return res.json({ success: true, imageUrl: extractedImage });
        }

        return res.status(404).json({ success: false, message: 'No valid product image found' });

    } catch (err) {
        console.error("Extractor Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// Proxy Image Streaming Route
app.get('/api/proxy-image', async (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('URL required');

    try {
        targetUrl = decodeURIComponent(targetUrl).trim();
        if (targetUrl.startsWith('//')) targetUrl = 'https:' + targetUrl;

        const imgRes = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
            }
        });

        if (!imgRes.ok) throw new Error(`Image stream failed: ${imgRes.status}`);

        const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=86400');

        const buffer = await imgRes.arrayBuffer();
        res.send(Buffer.from(buffer));

    } catch (err) {
        console.error("Proxy error:", err.message);
        res.status(500).send(`Proxy failure: ${err.message}`);
    }
});

async function extractAndCleanGarment(rawImageUrl) {
    try {
        const cleanResult = await fal.subscribe("fal-ai/birefnet", {
            input: { image_url: rawImageUrl },
            logs: false
        });
        if (cleanResult.data?.image?.url) return cleanResult.data.image.url;
    } catch (err) {
        console.warn("⚠️ Garment isolation skipped:", err.message);
    }
    return rawImageUrl;
}

// ==========================================
// 🚀 3. HEALTH CHECK ROOT
// ==========================================
app.get('/', (req, res) => {
    res.send('FitOut AI Backend is Live and Active 🚀');
});

// ==========================================
// 👤 4. AUTH & PROFILE
// ==========================================
app.post('/api/auth/login', (req, res) => {
    try {
        const { identifier } = req.body;
        if (!identifier || identifier.trim() === '') {
            return res.status(400).json({ success: false, error: "Email or Phone is required" });
        }

        const cleanIdentifier = identifier.trim().toLowerCase();
        const db = readDB();

        let user = db.users.find(u => u.identifier === cleanIdentifier);
        if (!user) {
            user = {
                id: 'usr_' + Date.now(),
                identifier: cleanIdentifier,
                credits: 5,
                ads_watched: 0,
                created_at: new Date().toISOString()
            };
            db.users.push(user);
            writeDB(db);
            console.log(`✨ New User Registered: ${cleanIdentifier}`);
        }

        const token = jwt.sign({ id: user.id, identifier: user.identifier }, JWT_SECRET, { expiresIn: '30d' });
        return res.json({ success: true, token, user });
    } catch (err) {
        console.error("❌ Login Server Error:", err);
        return res.status(500).json({ success: false, error: "Internal Auth Error" });
    }
});

app.get('/api/user/profile', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ success: false, error: "Unauthorized" });

    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);

        const db = readDB();
        const user = db.users.find(u => u.id === decoded.id);
        if (!user) return res.status(404).json({ success: false, error: "User not found" });

        const generations = db.generations.filter(g => g.user_id === user.id).reverse();
        const transactions = db.transactions.filter(t => t.user_id === user.id).reverse();

        res.json({
            success: true,
            user,
            stats: {
                totalGenerated: generations.length,
                totalPaid: transactions.reduce((acc, curr) => acc + (curr.amount || 0), 0)
            },
            generations,
            transactions
        });
    } catch (e) {
        res.status(401).json({ success: false, error: "Invalid Session" });
    }
});

// ==========================================
// 📺 5. WATCH 3 ADS -> +1 CREDIT
// ==========================================
app.post('/api/user/watch-ad', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ success: false, error: "Unauthorized" });

    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);

        const db = readDB();
        const user = db.users.find(u => u.id === decoded.id);
        if (!user) return res.status(404).json({ success: false, error: "User not found" });

        user.ads_watched = (user.ads_watched || 0) + 1;
        let creditAdded = false;

        if (user.ads_watched >= 3) {
            user.credits = (user.credits || 0) + 1;
            user.ads_watched = 0;
            creditAdded = true;
        }

        writeDB(db);

        res.json({
            success: true,
            adsWatched: user.ads_watched,
            remainingAdsNeeded: 3 - user.ads_watched,
            credits: user.credits,
            creditUnlocked: creditAdded
        });
    } catch (e) {
        res.status(400).json({ success: false, error: "Failed to record ad view" });
    }
});

// ==========================================
// 👗 6. TRY-ON PIPELINE (FASHN V1.6)
// ==========================================
app.post('/api/tryon', async (req, res) => {
    try {
        const { personImage, clothingImage, isProUser } = req.body;

        if (!personImage || !clothingImage) {
            return res.status(400).json({ success: false, error: "Both User Photo and Cloth Image are required." });
        }

        console.log("⏳ Uploading input images to cloud...");
        const humanImageUrl = await uploadToFal(personImage);
        let garmentImageUrl = await uploadToFal(clothingImage);

        garmentImageUrl = await extractAndCleanGarment(garmentImageUrl);

        let finalResultUrl = null;

        console.log("⚡ Running Try-On Mode...");
        const result = await fal.subscribe("fal-ai/fashn/tryon/v1.6", {
            input: {
                model_image: humanImageUrl,
                garment_image: garmentImageUrl,
                category: "tops",
                mode: isProUser ? "quality" : "performance",
                garment_photo_type: "auto",
                nsfw_filter: true
            },
            logs: true
        });

        finalResultUrl = result.data?.images?.[0]?.url || result.data?.image?.url;

        if (!finalResultUrl) {
            throw new Error("AI could not generate the try-on output image.");
        }

        console.log("✅ Try-On Generated Successfully:", finalResultUrl);
        return res.json({ 
            success: true, 
            resultImageUrl: finalResultUrl,
            resultImage: finalResultUrl 
        });

    } catch (error) {
        console.error("❌ TryOn Server Error:", error);
        return res.status(500).json({ 
            success: false, 
            error: error.message || "Failed to process AI Try-On" 
        });
    }
});

// ==========================================
// 💳 7. RAZORPAY PAYMENT
// ==========================================
app.post('/api/create-order', async (req, res) => {
    try {
        const { amount } = req.body;
        const options = {
            amount: Number(amount) || 4900,
            currency: "INR",
            receipt: "receipt_order_" + Date.now()
        };
        const order = await razorpay.orders.create(options);
        res.json({ 
            success: true, 
            order, 
            key: process.env.RAZORPAY_KEY_ID  
        });
    } catch (error) {
        console.error("Razorpay Order Error:", error);
        res.status(500).json({ success: false, error: 'Failed to create payment order' });
    }
});

app.post('/api/verify-payment', (req, res) => {
    const { userId, paymentId, amount, credits } = req.body;
    if (!paymentId) return res.status(400).json({ success: false, error: "Invalid payment data" });

    const creditToAdd = Number(credits) || 10;
    const db = readDB();
    const user = db.users.find(u => u.id === userId || u.identifier === userId);
    
    if (user) {
        user.credits = (user.credits || 0) + creditToAdd;
        db.transactions.push({
            id: Date.now(),
            user_id: user.id,
            payment_id: paymentId,
            amount: amount || 49,
            credits_added: creditToAdd,
            created_at: new Date().toISOString()
        });
        writeDB(db);
    }

    res.json({ success: true, message: `+${creditToAdd} Credits Added!`, credits: user ? user.credits : creditToAdd });
});

// ==========================================
// 🔌 8. PORT LISTENER
// ==========================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running smoothly on port ${PORT}`);
});
