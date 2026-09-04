import express from 'express';
import cors from 'cors';
import multer from 'multer';
import Razorpay from 'razorpay';
import dotenv from 'dotenv';
import { fal } from '@fal-ai/client';
import jwt from 'jsonwebtoken';
import fs from 'fs';

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
    key_id: process.env.RAZORPAY_KEY_ID || "rzp_test_TUSdX927htYDhm",
    key_secret: process.env.RAZORPAY_SECRET || "kaPOuPzkj8XhNV9SdUgZAmeA"
});

// ==========================================
// 🛠️ HELPER FUNCTIONS FOR FAL UPLOAD & AI
// ==========================================
async function uploadToFal(imageInput) {
    if (!imageInput) return null;
    if (typeof imageInput === 'string' && imageInput.startsWith('http')) {
        return imageInput;
    }
    
    // Convert Base64 Data URL to Blob
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

app.get('/api/proxy-image', async (req, res) => {
  let targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('URL required');

  try {
    targetUrl = decodeURIComponent(targetUrl).trim();
    if (targetUrl.startsWith('//')) targetUrl = 'https:' + targetUrl;

    const isDirectImage = targetUrl.match(/\.(jpeg|jpg|png|webp|avif)($|\?)/i);

    // 1. अगर लिंक वेबपेज का है (Myntra, Flipkart, Amazon, Meesho)
    if (!isDirectImage) {
      if (targetUrl.includes('myntra.com')) {
        // Myntra के लिए Microlink का हेडलेस ब्राउज़र स्क्रीनशॉट/इमेज एक्सट्रैक्टर
        const microUrl = `https://api.microlink.io?url=${encodeURIComponent(targetUrl)}&screenshot=true&meta=false&embed=screenshot.url`;
        return res.redirect(microUrl);
      }

      // Flipkart, Amazon, Meesho के लिए नॉर्मल मेटा एक्सट्रैक्टर
      const metaRes = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(targetUrl)}`);
      const metaData = await metaRes.json();

      if (metaData?.status === 'success' && metaData?.data?.image?.url) {
        targetUrl = metaData.data.image.url;
      } else {
        return res.status(404).send('Product preview image not found');
      }
    }

    // 2. डायरेक्ट इमेज को बाइनरी में स्ट्रीम करें
    const imgRes = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
      }
    });

    if (!imgRes.ok) throw new Error(`CDN fetch failed: ${imgRes.status}`);

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
// 🚀 2. HEALTH CHECK ROOT
// ==========================================
app.get('/', (req, res) => {
    res.send('FitOut AI Backend is Live and Active 🚀');
});

// ==========================================
// 👤 3. AUTH & PROFILE
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
// 📺 4. WATCH 3 ADS -> +1 CREDIT
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
// 👗 5. TRY-ON PIPELINE (DUAL ENGINE: KOLORS & FASHN)
// ==========================================
app.post('/api/tryon', async (req, res) => {
    try {
        const { personImage, clothingImage, isProUser } = req.body;

        if (!personImage || !clothingImage) {
            return res.status(400).json({ success: false, error: "Both User Photo and Cloth Image are required." });
        }

        // 1. Upload Base64/URLs to FAL Cloud Storage
        console.log("⏳ Uploading input images to cloud...");
        const humanImageUrl = await uploadToFal(personImage);
        let garmentImageUrl = await uploadToFal(clothingImage);

        // 2. Clean garment background for better precision
        garmentImageUrl = await extractAndCleanGarment(garmentImageUrl);

        let finalResultUrl = null;

        if (isProUser) {
            // 🌟 PRO TIER: FASHN v1.6
            console.log("⚡ Running Fast Try-On Mode...");
console.log("Model URL:", humanImageUrl);
console.log("Garment URL:", garmentImageUrl);

const result = await fal.subscribe("fal-ai/fashn/tryon/v1.6", {
    input: {
        model_image: humanImageUrl,
        garment_image: garmentImageUrl,
        category: "tops",
        mode: "performance",
        garment_photo_type: "auto",
        nsfw_filter: true
    },
    logs: true
});
            finalResultUrl = result.data?.images?.[0]?.url || result.data?.image?.url;
        } else {
            // ⚡ STANDARD / FREE TIER: Fast Kolors Try-On
            console.log("⚡ Running Kolors Virtual Try-On (Fast Mode)...");
            const result = await fal.subscribe("fal-ai/fashn/tryon/v1.6", {
                input: {
                    model_image: humanImageUrl,
                    garment_image: garmentImageUrl
                },
                logs: true
            });
            finalResultUrl = result.data?.image?.url || result.data?.images?.[0]?.url;
        }

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
    console.error("❌ Detailed Error:", JSON.stringify(error.body || error, null, 2));
    return res.status(500).json({ 
        success: false, 
        error: error.message || "Failed to process AI Try-On" 
    });
}
});

// Multipart compatibility for FormData
app.post('/api/generate', upload.fields([{ name: 'userImage', maxCount: 1 }, { name: 'clothImage', maxCount: 1 }]), async (req, res) => {
    try {
        const files = req.files;
        if (!files || !files['userImage']) return res.status(400).json({ success: false, error: 'User image is required' });

        const humanBlob = new Blob([files['userImage'][0].buffer], { type: files['userImage'][0].mimetype || 'image/jpeg' });
        const humanImageUrl = await fal.storage.upload(humanBlob);

        let rawGarmentUrl = "";
        if (files['clothImage']) {
            const clothBlob = new Blob([files['clothImage'][0].buffer], { type: files['clothImage'][0].mimetype || 'image/jpeg' });
            rawGarmentUrl = await fal.storage.upload(clothBlob);
        } else if (req.body.clothImageUrl) {
            const downloadedCloth = await fetchImageAsBlob(req.body.clothImageUrl);
            rawGarmentUrl = await fal.storage.upload(downloadedCloth);
        }

        const cleanedGarmentUrl = await extractAndCleanGarment(rawGarmentUrl);

        const result = await fal.subscribe("fal-ai/fashn/tryon/v1.6", {
            input: {
                model_image: humanImageUrl,
                garment_image: cleanedGarmentUrl,
                category: "tops",
                mode: "quality",
                garment_photo_type: "auto"
            },
            logs: true
        });

        const rawResultUrl = result.data?.images?.[0]?.url || result.data?.image?.url;
        if (!rawResultUrl) throw new Error("FASHN Try-On Generation failed");

        res.json({ success: true, resultImageUrl: rawResultUrl });
    } catch (error) {
        console.error("❌ Generate Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 💳 6. RAZORPAY PAYMENT
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
            key: process.env.RAZORPAY_KEY_ID || "rzp_test_TUSdX927htYDhm" 
        });
    } catch (error) {
        console.error("Razorpay Order Error:", error);
        res.status(500).json({ success: false, error: 'Failed to create payment order' });
    }
});

app.post('/api/verify-payment', (req, res) => {
    const { userId, paymentId, amount } = req.body;
    if (!userId || !paymentId) return res.status(400).json({ success: false, error: "Invalid payment data" });

    const db = readDB();
    const user = db.users.find(u => u.id === userId);
    if (user) {
        user.credits = (user.credits || 0) + 20;
        db.transactions.push({
            id: Date.now(),
            user_id: user.id,
            payment_id: paymentId,
            amount: amount || 99,
            credits_added: 20,
            created_at: new Date().toISOString()
        });
        writeDB(db);
    }

    res.json({ success: true, message: "+20 Credits Added!", credits: user ? user.credits : 20 });
});

// ==========================================
// 🔌 7. PORT LISTENER
// ==========================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running smoothly on port ${PORT}`);
});
