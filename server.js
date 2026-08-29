import express from 'express';
import cors from 'cors';
import multer from 'multer';
import Razorpay from 'razorpay';
import dotenv from 'dotenv';
import { fal } from '@fal-ai/client';
import jwt from 'jsonwebtoken';
import fs from 'fs';

dotenv.config();

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
// 🗄️ 1. BULLETPROOF ZERO-DEPENDENCY DATABASE
// ==========================================
const DB_FILE = './database.json';

// Initialize DB file if not exists
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
    key_id: process.env.RAZORPAY_KEY_ID || "rzp_test_placeholder",
    key_secret: process.env.RAZORPAY_SECRET || "rzp_secret_placeholder"
});

// ==========================================
// 🚀 2. HEALTH CHECK ROOT (For Cron & Ping)
// ==========================================
app.get('/', (req, res) => {
    res.send('FitOut AI Backend is Live and Active 🚀');
});

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

async function extractAndCleanGarment(rawImageUrl) {
    try {
        const cleanResult = await fal.subscribe("fal-ai/birefnet", {
            input: { image_url: rawImageUrl },
            logs: false
        });
        if (cleanResult.data?.image?.url) return cleanResult.data.image.url;
    } catch (err) {
        console.warn("⚠️ Isolation skipped:", err.message);
    }
    return rawImageUrl;
}

async function enhanceToUltraHD(imageUrl) {
    try {
        const enhancedResult = await fal.subscribe("fal-ai/ccsr", {
            input: { image_url: imageUrl, scale: 2 },
            logs: false
        });
        if (enhancedResult.data?.image?.url) return enhancedResult.data.image.url;
    } catch (err) {
        console.warn("⚠️ HD Upscale skipped:", err.message);
    }
    return imageUrl;
}

// ==========================================
// 👤 3. ROCK-SOLID AUTH & PROFILE
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
                credits: 5, // 5 Free Welcome Credits for new users
                ads_watched: 0,
                created_at: new Date().toISOString()
            };
            db.users.push(user);
            writeDB(db);
            console.log(`✨ New User Registered: ${cleanIdentifier}`);
        } else {
            console.log(`👤 User Logged In: ${cleanIdentifier}`);
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
                totalPaid: transactions.reduce((acc, curr) => acc + curr.amount, 0)
            },
            generations,
            transactions
        });
    } catch (e) {
        res.status(401).json({ success: false, error: "Invalid Session" });
    }
});

// ==========================================
// 📺 4. WATCH 5 ADS -> +1 CREDIT
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

        if (user.ads_watched >= 5) {
            user.credits = (user.credits || 0) + 1;
            user.ads_watched = 0;
            creditAdded = true;
        }

        writeDB(db);

        res.json({
            success: true,
            adsWatched: user.ads_watched,
            remainingAdsNeeded: 5 - user.ads_watched,
            credits: user.credits,
            creditUnlocked: creditAdded
        });
    } catch (e) {
        res.status(400).json({ success: false, error: "Failed to record ad view" });
    }
});

// ==========================================
// 👗 5. TRY-ON PIPELINE (MULTIPART & JSON)
// ==========================================
// Supports Multipart Upload as well as Direct Base64 / JSON Endpoints
app.post('/api/generate', upload.fields([{ name: 'userImage', maxCount: 1 }, { name: 'clothImage', maxCount: 1 }]), async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ success: false, error: "Login required" });

    let userId = null;
    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        userId = decoded.id;
    } catch (e) {
        return res.status(401).json({ success: false, error: "Invalid session" });
    }

    const db = readDB();
    const user = db.users.find(u => u.id === userId);
    if (!user || user.credits < 1) {
        return res.status(403).json({ success: false, error: "No credits left", outOfCredits: true });
    }

    try {
        const files = req.files;
        const clothImageUrl = req.body.clothImageUrl;

        if (!files || !files['userImage']) return res.status(400).json({ success: false, error: 'User image is required' });

        fal.config({ credentials: process.env.FAL_KEY });

        const humanBlob = new Blob([files['userImage'][0].buffer], { type: files['userImage'][0].mimetype || 'image/jpeg' });
        const humanImageUrl = await fal.storage.upload(humanBlob);

        let rawGarmentUrl = "";
        if (files['clothImage']) {
            const clothBlob = new Blob([files['clothImage'][0].buffer], { type: files['clothImage'][0].mimetype || 'image/jpeg' });
            rawGarmentUrl = await fal.storage.upload(clothBlob);
        } else if (clothImageUrl && clothImageUrl.trim() !== '') {
            const downloadedCloth = await fetchImageAsBlob(clothImageUrl);
            rawGarmentUrl = await fal.storage.upload(downloadedCloth);
        }

        if (!rawGarmentUrl) return res.status(400).json({ success: false, error: 'Cloth image is required' });

        const cleanedGarmentUrl = await extractAndCleanGarment(rawGarmentUrl);

        const result = await fal.subscribe("fal-ai/kling/v1-5/kolors-virtual-try-on", {
            input: {
                human_image_url: humanImageUrl,
                garment_image_url: cleanedGarmentUrl,
                preserve_background: true
            },
            logs: true
        });

        const rawResultUrl = result.data?.image?.url;
        if (!rawResultUrl) throw new Error("Try-On Generation failed");

        const finalHdUrl = await enhanceToUltraHD(rawResultUrl);

        user.credits -= 1;
        db.generations.push({
            id: Date.now(),
            user_id: user.id,
            image_url: finalHdUrl,
            created_at: new Date().toISOString()
        });
        writeDB(db);

        res.json({
            success: true,
            resultImageUrl: finalHdUrl,
            resultImage: finalHdUrl,
            remainingCredits: user.credits
        });

    } catch (error) {
        console.error("❌ TryOn Error:", error);
        res.status(500).json({ success: false, error: 'Generation Failed', details: error.message });
    }
});

// Dual endpoint compatibility for App.jsx (/api/tryon)
app.post('/api/tryon', async (req, res) => {
    console.log('===> Received /api/tryon request');
    try {
        const { personImage, clothingImage, clothingLink } = req.body;
        if (!personImage) {
            return res.status(400).json({ error: 'Person image is required' });
        }

        fal.config({ credentials: process.env.FAL_KEY });

        // Upload Person image
        let humanImageUrl = personImage;
        if (personImage.startsWith('data:')) {
            const base64Data = personImage.split(',')[1];
            const mime = personImage.split(';')[0].split(':')[1];
            const buffer = Buffer.from(base64Data, 'base64');
            const blob = new Blob([buffer], { type: mime });
            humanImageUrl = await fal.storage.upload(blob);
        }

        // Upload Garment image
        let rawGarmentUrl = clothingImage || clothingLink;
        if (clothingImage && clothingImage.startsWith('data:')) {
            const base64Data = clothingImage.split(',')[1];
            const mime = clothingImage.split(';')[0].split(':')[1];
            const buffer = Buffer.from(base64Data, 'base64');
            const blob = new Blob([buffer], { type: mime });
            rawGarmentUrl = await fal.storage.upload(blob);
        } else if (clothingLink && clothingLink.startsWith('http')) {
            const downloadedCloth = await fetchImageAsBlob(clothingLink);
            rawGarmentUrl = await fal.storage.upload(downloadedCloth);
        }

        if (!rawGarmentUrl) {
            return res.status(400).json({ error: 'Outfit image or valid link is required' });
        }

        const cleanedGarmentUrl = await extractAndCleanGarment(rawGarmentUrl);

        const result = await fal.subscribe("fal-ai/kling/v1-5/kolors-virtual-try-on", {
            input: {
                human_image_url: humanImageUrl,
                garment_image_url: cleanedGarmentUrl,
                preserve_background: true
            },
            logs: true
        });

        const rawResultUrl = result.data?.image?.url;
        if (!rawResultUrl) throw new Error("Try-On Generation failed");

        const finalHdUrl = await enhanceToUltraHD(rawResultUrl);

        return res.json({ 
            success: true, 
            resultImage: finalHdUrl,
            resultImageUrl: finalHdUrl 
        });

    } catch (error) {
        console.error('❌ /api/tryon Error:', error);
        return res.status(500).json({ 
            error: 'Failed to process AI Try-On', 
            details: error.message 
        });
    }
});

// ==========================================
// 💳 6. RAZORPAY PAYMENT
// ==========================================
app.post('/api/create-order', async (req, res) => {
    try {
        const options = {
            amount: 9900,
            currency: "INR",
            receipt: "receipt_order_" + Date.now()
        };
        const order = await razorpay.orders.create(options);
        res.json({ success: true, order });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to create payment order' });
    }
});

app.post('/api/verify-payment', (req, res) => {
    const { userId, paymentId, amount } = req.body;
    if (!userId || !paymentId) return res.status(400).json({ success: false, error: "Invalid payment data" });

    const db = readDB();
    const user = db.users.find(u => u.id === userId);
    if (user) {
        user.credits += 20;
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
// 🔌 7. PORT LISTENER (Render Dynamic Port Fix)
// ==========================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running smoothly on port ${PORT}`);
});
