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
// 🗄️ 1. DATABASE SETUP
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


if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({ 
    users: [], 
    generations: [], 
    transactions: [], 
    catalog: INITIAL_CLOTHES 
  }, null, 2));
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
      writeDB(data);
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
  const blob = typeof Blob !== 'undefined' 
    ? new Blob([buffer], { type: contentType }) 
    : new (await import('buffer')).Blob([buffer], { type: contentType });
    
  return await fal.storage.upload(blob);
}

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
// 👤 4. AUTH & PROFILE
// ==========================================
app.post('/api/auth/login', (req, res) => {
  try {
    const { identifier } = req.body;
    if (!identifier || identifier.trim() === '') {
      return res.status(400).json({ success: false, error: "Identifier required" });
    }

    const cleanIdentifier = identifier.trim().toLowerCase();
    const db = readDB();

    let user = db.users.find(u => u.identifier === cleanIdentifier);
    if (!user) {
      user = {
        id: 'usr_' + Date.now(),
        identifier: cleanIdentifier,
        credits: 3,
        is_pro: true, // Sabhi ke liye FASHN 1.6 active
        ads_watched: 0,
        created_at: new Date().toISOString()
      };
      db.users.push(user);
      writeDB(db);
    }

    const token = jwt.sign({ id: user.id, identifier: user.identifier }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({ success: true, token, user });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Internal Auth Error" });
  }
});

// ==========================================
// 💳 5. IN-APP CREDIT PURCHASE ROUTE
// ==========================================
app.post('/api/buy-credits', (req, res) => {
  const { userId, planType, creditsPurchased, amountPaid, orderId } = req.body;
  if (!userId || !creditsPurchased) {
    return res.status(400).json({ success: false, error: "Invalid purchase details" });
  }

  const db = readDB();
  let user = db.users.find(u => u.id === userId || u.identifier === userId);

  if (!user) {
    user = {
      id: 'usr_' + Date.now(),
      identifier: userId,
      credits: 0,
      is_pro: true,
      created_at: new Date().toISOString()
    };
    db.users.push(user);
  }

  user.credits = (user.credits || 0) + Number(creditsPurchased);
  user.is_pro = true;

  db.transactions.push({
    id: 'txn_' + Date.now(),
    user_id: user.id,
    orderId: orderId || `GP_PAY_${Date.now()}`,
    plan: planType || `₹${amountPaid} Pack`,
    amount: amountPaid,
    creditsAdded: creditsPurchased,
    date: new Date().toISOString()
  });

  writeDB(db);

  return res.json({
    success: true,
    credits: user.credits,
    isPro: true,
    message: `🎉 ₹${amountPaid} पैक सफल! +${creditsPurchased} Credits जुड़ गए हैं।`
  });
});

// ==========================================
// 👗 6. TRY-ON PIPELINE (FREE HUGGING FACE IDM-VTON)
// ==========================================
// Helper function: Base64 string ya URL ko Gradio format me convert karne ke liye
function prepareGradioFile(input) {
  if (typeof input === 'string') {
    if (input.startsWith('http://') || input.startsWith('https://')) {
      return handle_file(input);
    }
    // Agar Base64 data URL hai (data:image/jpeg;base64,...)
    const base64Clean = input.includes(';base64,') ? input.split(';base64,')[1] : input;
    const imgBuffer = Buffer.from(base64Clean, 'base64');
    return handle_file(imgBuffer);
  }
  return handle_file(input);
}

app.post('/api/tryon', async (req, res) => {
  try {
    const { personImage, clothingImage, category } = req.body;

    if (!personImage || !clothingImage) {
      return res.status(400).json({ 
        success: false, 
        error: "Both User Photo and Cloth Image are required." 
      });
    }

    console.log("Try-on request received. Connecting to Hugging Face IDM-VTON...");

    // Hugging Face Space se connect karein
    const hfClient = await Client.connect("yisol/IDM-VTON", {
      token: process.env.HF_TOKEN
    });

    console.log("Processing images with IDM-VTON...");

    // Gradio ke exact format ke mutabik inputs pass karein
    const result = await hfClient.predict("/tryon", [
      { 
        background: prepareGradioFile(personImage),
        layers: [],
        composite: null 
      },                             // 1. User image structure
      prepareGradioFile(clothingImage), // 2. Garment image
      "Virtual try-on outfit",       // 3. Prompt description
      true,                          // 4. Auto-masking (is_checked)
      true,                          // 5. Crop (is_checked_crop)
      30,                            // 6. Denoise steps
      42                             // 7. Seed
    ]);

    console.log("Try-On successful! Output received.");

    // Result URL extract karein
    const finalResultUrl = result.data?.[0]?.url || result.data?.[0];

    if (!finalResultUrl) {
      throw new Error("AI returned empty result from Hugging Face");
    }

    return res.json({ 
      success: true, 
      resultImageUrl: finalResultUrl,
      appliedCategory: category || "tops"
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
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ FitOut AI Backend running on port ${PORT}`);
});
