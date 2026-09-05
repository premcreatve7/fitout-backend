import express from 'express';
import cors from 'cors';
import multer from 'multer';
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

        // 1. अगर शेयर बटन से पूरा टेक्स्ट आया है, तो सिर्फ https URL छाँटें
        const urlMatch = url.match(/(https?:\/\/[^\s]+)/i);
        if (urlMatch) {
            url = urlMatch[0].trim();
        }

        if (url.startsWith('//')) url = 'https:' + url;

        // 2. अगर सीधे इमेज URL है तो बेस64 में बदलें
        if (url.match(/\.(jpeg|jpg|png|webp|avif)($|\?)/i)) {
            try {
                const directImg = await axios.get(url, { responseType: 'arraybuffer', timeout: 8000 });
                const b64 = Buffer.from(directImg.data, 'binary').toString('base64');
                const mime = directImg.headers['content-type'] || 'image/jpeg';
                return res.json({ success: true, imageUrl: `data:${mime};base64,${b64}` });
            } catch {
                return res.json({ success: true, imageUrl: url });
            }
        }

        // 3. Meesho और Flipkart के रीडायरेक्ट/शॉर्ट लिंक्स रिज़ॉल्व करें
        try {
            const headRes = await axios.get(url, {
                maxRedirects: 5,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                },
                timeout: 7000
            });
            if (headRes.request?.res?.responseUrl) {
                url = headRes.request.res.responseUrl;
            }
        } catch (e) {
            // रीडायरेक्ट फेल होने पर ओरिजिनल URL से आगे बढ़ें
        }

        const isValidProductImage = (img) => {
            if (!img || typeof img !== 'string') return false;
            const lower = img.toLowerCase();
            return !(lower.endsWith('.svg') || lower.includes('logo') || lower.includes('akamai') || lower.includes('captcha') || lower.includes('placeholder') || lower.includes('icon') || lower.includes('badge'));
        };

        let extractedImage = null;

        // 4. मल्टी-प्रॉक्सी इंजन
        const proxyUrls = [
            `https://corsproxy.io/?${encodeURIComponent(url)}`,
            `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
            `https://api.microlink.io/?url=${encodeURIComponent(url)}&prerender=true&filter=image`
        ];

        for (const proxyUrl of proxyUrls) {
            try {
                if (proxyUrl.includes('microlink.io')) {
                    const microRes = await fetch(proxyUrl);
                    const microData = await microRes.json();
                    const candidate = microData?.data?.image?.url;
                    if (candidate && isValidProductImage(candidate)) {
                        extractedImage = candidate;
                        break;
                    }
                } else {
                    const scrapeRes = await axios.get(proxyUrl, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                        },
                        timeout: 7000
                    });

                    const $ = cheerio.load(scrapeRes.data);
                    
                    let candidate = $('meta[property="og:image"]').attr('content') || 
                                   $('meta[name="twitter:image"]').attr('content') ||
                                   $('meta[property="og:image:secure_url"]').attr('content');

                    if (!candidate || !isValidProductImage(candidate)) {
                        $('img').each((_, el) => {
                            const src = $(el).attr('src') || $(el).attr('data-src');
                            if (isValidProductImage(src) && (
                                src.includes('images.meesho.com') || 
                                src.includes('rukminim') || 
                                src.includes('media-amazon.com') ||
                                src.includes('m.media-amazon.com')
                            )) {
                                candidate = src;
                                return false;
                            }
                        });
                    }

                    if (candidate && isValidProductImage(candidate)) {
                        extractedImage = candidate;
                        break;
                    }
                }
            } catch (proxyErr) {
                continue;
            }
        }

        // 5. इमेज को Base64 में कन्वर्ट करें ताकि WebView में ब्लॉक न हो
        if (extractedImage) {
            if (extractedImage.startsWith('//')) extractedImage = 'https:' + extractedImage;
            
            try {
                const imgDownload = await axios.get(extractedImage, {
                    responseType: 'arraybuffer',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    },
                    timeout: 8000
                });
                const base64Data = Buffer.from(imgDownload.data, 'binary').toString('base64');
                const mimeType = imgDownload.headers['content-type'] || 'image/jpeg';
                return res.json({ 
                    success: true, 
                    imageUrl: `data:${mimeType};base64,${base64Data}` 
                });
            } catch (err) {
                return res.json({ success: true, imageUrl: extractedImage });
            }
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
        const { personImage, clothingImage, category, isProUser } = req.body;

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
                category: category || "tops",
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
// 💳 7. GOOGLE PLAY BILLING (COMING SOON)
// ==========================================
app.post('/api/create-order', async (req, res) => {
    return res.status(400).json({ 
        success: false, 
        error: "Google Play In-App Billing is coming soon in the next update!" 
    });
});

app.post('/api/verify-payment', (req, res) => {
    return res.status(400).json({ 
        success: false, 
        error: "Google Play In-App Billing is coming soon in the next update!" 
    });
});

// ==========================================
// 🔌 8. PORT LISTENER
// ==========================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running smoothly on port ${PORT}`);
});
