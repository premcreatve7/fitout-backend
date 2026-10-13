import express from 'express';
import cors from 'cors';
import multer from 'multer';
import dotenv from 'dotenv';
import { Client, handle_file } from "@gradio/client";
import jwt from 'jsonwebtoken';
import fs from 'fs';
import axios from 'axios';

dotenv.config();

const app = express();

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
// 🗄️ 1. DATABASE & DAILY CREDIT RESET SYSTEM
// ==========================================
const DB_FILE = './database.json';

const INITIAL_CLOTHES = [
  {
    id: 'hp_01',
    title: 'Yellow Floral Top',
    category: 'tops',
    tag: 'Trending',
    imageUrl: 'https://assets.ajio.com/medias/sys_master/root/h73/ha5/16407570612254/-473Wx593H-461161841-yellow-MODEL.jpg',
    affiliateUrl: 'https://ajiio.in/tFndB6q'
  },
  {
    id: 'hp_02',
    title: 'Casual Printed Wear',
    category: 'tops',
    tag: 'Hot',
    imageUrl: 'https://assets.myntassets.com/h_720,q_90,w_540/v1/assets/images/productimage/2019/9/10/956f6d80-09df-44b3-b881-d826bb3eaaae1568112535637-1.jpg',
    affiliateUrl: 'https://myntr.it/oCgMAHo'
  },
  {
    id: 'hp_03',
    title: 'Yellow Kurti / Tunic',
    category: 'tops',
    tag: 'Popular',
    imageUrl: 'https://assets.ajio.com/medias/sys_master/root/20200731/AjbB/5f2320517cdb8ca2cf88859d/-473Wx593H-461343341-yellow-MODEL.jpg',
    affiliateUrl: 'https://ajiio.in/iyyaADw'
  },
  {
    id: 'hp_04',
    title: 'Classic White Shirt / Top',
    category: 'tops',
    tag: 'Best Seller',
    imageUrl: 'https://assets.ajio.com/medias/sys_master/root/h07/hfa/14565431836702/-473Wx593H-441016995-white-MODEL.jpg',
    affiliateUrl: 'https://ajiio.in/x1YkKK0'
  }
];

function getTodayString() {
  return new Date().toISOString().split('T')[0]; // Format: YYYY-MM-DD
}

// Har user ke daily credits check aur reset karne ka function
function applyDailyCreditReset(user) {
  const today = getTodayString();
  if (user.last_credit_date !== today) {
    user.credits = 2; // Har roz naye 2 free credits
    user.last_credit_date = today;
    return true;
  }
  return false;
}

function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const initialData = { users: [], generations: [], transactions: [], catalog: INITIAL_CLOTHES };
      writeDB(initialData);
      return initialData;
    }

    const fileContent = fs.readFileSync(DB_FILE, 'utf-8').trim();
    if (!fileContent) {
      const initialData = { users: [], generations: [], transactions: [], catalog: INITIAL_CLOTHES };
      writeDB(initialData);
      return initialData;
    }

    const data = JSON.parse(fileContent);
    if (!data.catalog || data.catalog.length === 0) {
      data.catalog = INITIAL_CLOTHES;
    }
    return data;
  } catch (err) {
    return { users: [], generations: [], transactions: [], catalog: INITIAL_CLOTHES };
  }
}

function writeDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("DB Write Error:", e);
  }
}

// 🚀 Server start hone par purane sabhi users ke abnormal credits ko reset karein
function initialUserCreditWipe() {
  const db = readDB();
  const today = getTodayString();
  let updated = false;

  db.users.forEach(u => {
    // Agar kisi tester ne fake 10-50 credits liye the, unhe hata kar 2 credits par reset karein
    if (u.credits > 2 || u.last_credit_date !== today) {
      u.credits = 2;
      u.last_credit_date = today;
      updated = true;
    }
  });

  if (updated) {
    writeDB(db);
    console.log("🔄 All tester balances reset to daily 2 credits.");
  }
}
initialUserCreditWipe();

// ==========================================
// 👔 2. HANDPICKED CATALOG & ADMIN API
// ==========================================
app.get('/api/handpicked-clothes', (req, res) => {
  const db = readDB();
  res.json({ success: true, clothes: db.catalog || [] });
});

const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET || "fitout_admin_secret_786";

app.post('/api/admin/add-cloth', async (req, res) => {
  const { secretKey, title, amazonUrl, affiliateUrl, imageUrl, category, tag } = req.body;

  if (secretKey !== ADMIN_SECRET_KEY) {
    return res.status(403).json({ success: false, error: "Unauthorized: Invalid Secret Key" });
  }

  if (!title || (!amazonUrl && !imageUrl)) {
    return res.status(400).json({ success: false, error: "Title and Product Link/Image are required." });
  }

  try {
    let finalImageUrl = imageUrl;

    if (!finalImageUrl && amazonUrl) {
      const asinMatch = amazonUrl.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
      if (asinMatch && asinMatch[1]) {
        finalImageUrl = `https://images-na.ssl-images-amazon.com/images/P/${asinMatch[1]}.01.MAIN._SCRMZZZZZZ_.jpg`;
      } else {
        finalImageUrl = amazonUrl;
      }
    }

    const db = readDB();
    if (!db.catalog) db.catalog = [];

    const newCloth = {
      id: 'hp_' + Date.now(),
      title: title.trim(),
      category: category || detectGarmentCategory(title),
      tag: tag || 'Trending',
      imageUrl: finalImageUrl,
      affiliateUrl: affiliateUrl || amazonUrl || '#'
    };

    db.catalog.unshift(newCloth);
    writeDB(db);

    return res.json({ 
      success: true, 
      message: "Product added to catalog successfully!", 
      item: newCloth 
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Failed to add cloth to catalog." });
  }
});

function detectGarmentCategory(urlOrText) {
  const text = (urlOrText || '').toLowerCase();
  const bottomKeywords = ['jeans', 'pant', 'trouser', 'shorts', 'skirt', 'jogger', 'legging', 'lower', 'trackpant'];
  if (bottomKeywords.some(k => text.includes(k)) && !text.includes('set') && !text.includes('suit')) {
    return 'bottoms';
  }
  const fullBodyKeywords = ['dress', 'frock', 'gown', 'jumpsuit', 'maxi', 'suit', 'kurta', 'kurti', 'co-ord', 'set', 'saree', 'lehenga', 'anarkali'];
  if (fullBodyKeywords.some(k => text.includes(k))) {
    return 'one-pieces';
  }
  const topKeywords = ['shirt', 't-shirt', 'tshirt', 'top', 'crop', 'hoodie', 'jacket', 'blazer', 'sweater', 'blouse', 'shrug'];
  if (topKeywords.some(k => text.includes(k))) {
    return 'tops';
  }
  return 'one-pieces';
}

// ==========================================
// 🛍️ 3. E-COMMERCE SCRAPER
// ==========================================
app.post('/api/extract-image', async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ success: false, message: 'URL is required' });

  try {
    url = decodeURIComponent(url).trim();
    const urlMatch = url.match(/(https?:\/\/[^\s]+)/i);
    if (urlMatch) url = urlMatch[0].trim();
    if (url.startsWith('//')) url = 'https:' + url;

    if (url.match(/\.(jpeg|jpg|png|webp|avif)($|\?)/i) || 
      url.includes('media-amazon.com/images') || 
      url.includes('rukminim') || 
      url.includes('images.meesho.com')) {
      try {
        const directImg = await axios.get(url, { 
          responseType: 'arraybuffer', 
          timeout: 8000, 
          headers: { 'User-Agent': 'Mozilla/5.0' } 
        });
        const b64 = Buffer.from(directImg.data, 'binary').toString('base64');
        const mime = directImg.headers['content-type'] || 'image/jpeg';
        return res.json({ success: true, imageUrl: `data:${mime};base64,${b64}` });
      } catch (err) {
        return res.json({ success: true, imageUrl: url });
      }
    }

    let extractedImage = null;

    const meeshoMatch = url.match(/\/p\/([a-zA-Z0-9]+)/i);
    if (url.includes('meesho.com') && meeshoMatch && meeshoMatch[1]) {
      try {
        const meeshoRes = await axios.get(`https://www.meesho.com/api/v1/products/${meeshoMatch[1]}`, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.meesho.com/' },
          timeout: 6000
        });
        const pData = meeshoRes.data;
        if (pData?.images?.length > 0) extractedImage = pData.images[0];
        else if (pData?.product_images?.length > 0) extractedImage = pData.product_images[0].url;
      } catch (e) {}
    }

    const asinMatch = url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    if (url.includes('amazon') && asinMatch && asinMatch[1]) {
      extractedImage = `https://images-na.ssl-images-amazon.com/images/P/${asinMatch[1]}.01.MAIN._SCRMZZZZZZ_.jpg`;
    }

    if (!extractedImage) {
      try {
        const jinaRes = await axios.get(`https://r.jina.ai/${url}`, { headers: { 'X-Return-Format': 'markdown' }, timeout: 8000 });
        const mdText = typeof jinaRes.data === 'string' ? jinaRes.data : JSON.stringify(jinaRes.data);
        const imgMatches = mdText.match(/!\[.*?\]\((https?:\/\/[^\s\)]+)\)/gi);
        if (imgMatches && imgMatches.length > 0) {
          for (const m of imgMatches) {
            const singleUrl = m.match(/\((https?:\/\/[^\s\)]+)\)/)[1];
            const lower = singleUrl.toLowerCase();
            if (!lower.includes('logo') && !lower.includes('icon') && !lower.includes('badge') && !lower.includes('svg')) {
              extractedImage = singleUrl;
              break;
            }
          }
        }
      } catch (e) {}
    }

    if (extractedImage) {
      return res.json({ success: true, imageUrl: extractedImage });
    }

    return res.status(404).json({ success: false, message: 'Could not extract product photo.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error processing URL' });
  }
});

// ==========================================
// 👤 4. AUTH & PROFILE (Daily 2 Credits Auto-Refill)
// ==========================================
app.post('/api/auth/login', (req, res) => {
  try {
    const { identifier } = req.body;
    if (!identifier || identifier.trim() === '') {
      return res.status(400).json({ success: false, error: "Identifier required" });
    }

    const cleanIdentifier = identifier.trim().toLowerCase();
    const db = readDB();
    const today = getTodayString();

    let user = db.users.find(u => u.identifier === cleanIdentifier);
    if (!user) {
      // Naye tester ko seedha 2 credits milenge
      user = {
        id: 'usr_' + Date.now(),
        identifier: cleanIdentifier,
        credits: 2,
        last_credit_date: today,
        is_pro: true,
        ads_watched: 0,
        created_at: new Date().toISOString()
      };
      db.users.push(user);
      writeDB(db);
    } else {
      // Purane tester ke credits agar naya din hai toh 2 par refill honge
      if (applyDailyCreditReset(user)) {
        writeDB(db);
      }
    }

    const token = jwt.sign({ id: user.id, identifier: user.identifier }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({ success: true, token, user });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Internal Auth Error" });
  }
});

// User Profile / Balance Check Endpoint
app.get('/api/user/profile', (req, res) => {
  const userId = req.query.userId || req.headers['x-user-id'];
  if (!userId) {
    return res.status(400).json({ success: false, error: "User ID required" });
  }

  const db = readDB();
  const user = db.users.find(u => u.id === userId || u.identifier === userId.toLowerCase());
  if (!user) {
    return res.status(404).json({ success: false, error: "User not found" });
  }

  if (applyDailyCreditReset(user)) {
    writeDB(db);
  }

  return res.json({ success: true, user });
});

// ==========================================
// 💳 5. IN-APP PURCHASE LOCK (No Fake Credits)
// ==========================================
app.post('/api/buy-credits', (req, res) => {
  // Fake credit addition ko band kar diya gaya hai
  return res.json({
    success: false,
    message: "Purchase option agle update mein available hoga! Closed testing ke dauran aapko roz 2 free credits milenge."
  });
});

// ==========================================
// 👗 6. TRY-ON PIPELINE (HF IDM-VTON + Quota Check)
// ==========================================
async function convertOutputToBase64(rawOutput) {
  try {
    if (typeof rawOutput === 'string' && rawOutput.startsWith('data:image')) {
      return rawOutput;
    }

    const fileUrl = rawOutput?.url || (typeof rawOutput === 'string' && rawOutput.startsWith('http') ? rawOutput : null);
    const localPath = rawOutput?.path;

    if (localPath && fs.existsSync(localPath)) {
      const buffer = fs.readFileSync(localPath);
      return `data:image/png;base64,${buffer.toString('base64')}`;
    }

    if (fileUrl) {
      const headers = process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {};
      const response = await fetch(fileUrl, { headers });
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      return `data:image/png;base64,${buffer.toString('base64')}`;
    }

    return null;
  } catch (err) {
    console.error("Base64 conversion error:", err);
    return null;
  }
}

function prepareGradioFile(input) {
  if (typeof input === 'string') {
    if (input.startsWith('http://') || input.startsWith('https://')) {
      return handle_file(input);
    }
    const base64Clean = input.includes(';base64,') ? input.split(';base64,')[1] : input;
    const imgBuffer = Buffer.from(base64Clean, 'base64');
    return handle_file(imgBuffer);
  }
  return handle_file(input);
}

app.post('/api/tryon', async (req, res) => {
  try {
    const { personImage, clothingImage, category, userId } = req.body;

    if (!personImage || !clothingImage) {
      return res.status(400).json({ 
        success: false, 
        error: "Both User Photo and Cloth Image are required." 
      });
    }

    // 🔒 1. Credit Check Logic
    const db = readDB();
    let user = null;
    if (userId) {
      user = db.users.find(u => u.id === userId || u.identifier === userId.toLowerCase());
      if (user) {
        applyDailyCreditReset(user);
        if (user.credits <= 0) {
          return res.status(403).json({
            success: false,
            error: "Aapka aaj ka free quota (2 credits) khatam ho chuka hai! Kal naye credits milenge."
          });
        }
      }
    }

    console.log("Try-on request received. Connecting to Hugging Face IDM-VTON...");
    console.log("HF Token status:", process.env.HF_TOKEN ? "Loaded successfully" : "UNDEFINED");

    const hfClient = await Client.connect("premcreative7/IDM-VTON", {
      hf_token: process.env.HF_TOKEN,
      token: process.env.HF_TOKEN
    });

    console.log("Processing images with IDM-VTON...");

    const result = await hfClient.predict("/tryon", [
      { 
        background: prepareGradioFile(personImage),
        layers: [],
        composite: null 
      },
      prepareGradioFile(clothingImage),
      "Virtual try-on outfit",
      true,
      true,
      30,
      42
    ]);

    const finalResultUrl = await convertOutputToBase64(result.data?.[0]);

    if (!finalResultUrl) {
      throw new Error("Could not extract generated image from AI response");
    }

    // ✂️ 2. Generation success par 1 credit deduct karein
    if (user) {
      user.credits = Math.max(0, user.credits - 1);
      writeDB(db);
      console.log(`Credit deducted. Remaining for ${user.identifier}: ${user.credits}`);
    }

    console.log("Try-On successful! Sending base64 image to app.");

    return res.json({ 
      success: true, 
      resultImageUrl: finalResultUrl,
      appliedCategory: category || "tops",
      remainingCredits: user ? user.credits : undefined
    });

  } catch (error) {
    console.error("TryOn Error:", error);
    return res.status(500).json({ 
      success: false, 
      error: error.message || "Failed to process AI Try-On" 
    });
  }
});

// ==========================================
// 🔌 7. PORT LISTENER
// ==========================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ FitOut AI Backend running on port ${PORT}`);
});
