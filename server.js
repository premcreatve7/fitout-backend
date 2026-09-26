import express from 'express';
import cors from 'cors';
import multer from 'multer';
import dotenv from 'dotenv';
import { fal } from '@fal-ai/client';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import axios from 'axios';

dotenv.config();

fal.config({
  credentials: process.env.FAL_KEY
});

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
    id: 'hp_' + Date.now(),
    title: 'Trendy Casual Wear',
    category: 'tops', // Kapde ke hisaab se: 'tops', 'bottoms', ya 'one-pieces'
    tag: 'Trending',
    imageUrl: 'YAHAN_MYNTRA_IMAGE_KA_DIRECT_URL',
    affiliateUrl: 'https://myntr.it/Lwr8S7y'
  },
  {
    id: 'hp_01',
    title: 'Casual Outfit 01',
    category: 'tops', // Shirt/T-Shirt/Top ke liye 'tops', Jeans ke liye 'bottoms', Dress/Kurti ke liye 'one-pieces'
    tag: 'Trending',
    imageUrl: 'YAHAN_IMAGE_LINK_PASTE_KAREIN',
    affiliateUrl: 'https://myntr.it/mDZR9vp'
  },
  {
    id: 'hp_02',
    title: 'Casual Outfit 02',
    category: 'tops',
    tag: 'Hot',
    imageUrl: 'YAHAN_IMAGE_LINK_PASTE_KAREIN',
    affiliateUrl: 'https://myntr.it/0Z5igCk'
  },
  {
    id: 'hp_03',
    title: 'Trendy Wear 03',
    category: 'tops',
    tag: 'Best Seller',
    imageUrl: 'YAHAN_IMAGE_LINK_PASTE_KAREIN',
    affiliateUrl: 'https://ajiio.in/En2YTqx'
  },
  {
    id: 'hp_04',
    title: 'Casual Outfit 04',
    category: 'tops',
    tag: 'Trending',
    imageUrl: 'YAHAN_IMAGE_LINK_PASTE_KAREIN',
    affiliateUrl: 'https://myntr.it/562xzLC'
  },
  {
    id: 'hp_05',
    title: 'Trendy Wear 05',
    category: 'tops',
    tag: 'Hot',
    imageUrl: 'YAHAN_IMAGE_LINK_PASTE_KAREIN',
    affiliateUrl: 'https://ajiio.in/buZlepb'
  },
  {
    id: 'hp_06',
    title: 'Casual Outfit 06',
    category: 'tops',
    tag: 'Popular',
    imageUrl: 'YAHAN_IMAGE_LINK_PASTE_KAREIN',
    affiliateUrl: 'https://myntr.it/lzfjDaz'
  },
  {
    id: 'hp_07',
    title: 'Trendy Wear 07',
    category: 'tops',
    tag: 'Trending',
    imageUrl: 'YAHAN_IMAGE_LINK_PASTE_KAREIN',
    affiliateUrl: 'https://ajiio.in/U5A63xX'
  },
  {
    id: 'hp_08',
    title: 'Trendy Wear 08',
    category: 'tops',
    tag: 'Best Seller',
    imageUrl: 'YAHAN_IMAGE_LINK_PASTE_KAREIN',
    affiliateUrl: 'https://ajiio.in/KLx0wf2'
  },
  {
    id: 'hp_09',
    title: 'Casual Outfit 09',
    category: 'tops',
    tag: 'Hot',
    imageUrl: 'YAHAN_IMAGE_LINK_PASTE_KAREIN',
    affiliateUrl: 'https://myntr.it/skfnYuh'
  },
  {
    id: 'hp_10',
    title: 'Casual Outfit 10',
    category: 'tops',
    tag: 'Trending',
    imageUrl: 'YAHAN_IMAGE_LINK_PASTE_KAREIN',
    affiliateUrl: 'https://myntr.it/G67c0ft'
  },
  {
    id: 'hp_11',
    title: 'Trendy Wear 11',
    category: 'tops',
    tag: 'Popular',
    imageUrl: 'YAHAN_IMAGE_LINK_PASTE_KAREIN',
    affiliateUrl: 'https://ajiio.in/7pM5sTD'
  },
  {
    id: 'hp_12',
    title: 'Trendy Wear 12',
    category: 'tops',
    tag: 'Hot',
    imageUrl: 'YAHAN_IMAGE_LINK_PASTE_KAREIN',
    affiliateUrl: 'https://ajiio.in/jJZoZ7X'
  },
  {
    id: 'hp_13',
    title: 'Casual Outfit 13',
    category: 'tops',
    tag: 'Trending',
    imageUrl: 'YAHAN_IMAGE_LINK_PASTE_KAREIN',
    affiliateUrl: 'https://myntr.it/bBJuOJU'
  },
  {
    id: 'hp_14',
    title: 'Trendy Wear 14',
    category: 'tops',
    tag: 'Best Seller',
    imageUrl: 'YAHAN_IMAGE_LINK_PASTE_KAREIN',
    affiliateUrl: 'https://ajiio.in/c8UkJzC'
  },
  {
    id: 'hp_15',
    title: 'Casual Outfit 15',
    category: 'tops',
    tag: 'Trending',
    imageUrl: 'YAHAN_IMAGE_LINK_PASTE_KAREIN',
    affiliateUrl: 'https://myntr.it/WgbQtBN'
  },
  {
    id: 'hp_16',
    title: 'Casual Outfit 16',
    category: 'tops',
    tag: 'Hot',
    imageUrl: 'YAHAN_IMAGE_LINK_PASTE_KAREIN',
    affiliateUrl: 'https://myntr.it/bqYH88H'
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
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    if (!data.catalog) data.catalog = INITIAL_CLOTHES;
    return data;
  } catch {
    return { users: [], generations: [], transactions: [], catalog: INITIAL_CLOTHES };
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
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
// 👗 6. TRY-ON PIPELINE (FASHN V1.6 FOR ALL)
// ==========================================
app.post('/api/tryon', async (req, res) => {
  try {
    const { personImage, clothingImage, clothingLink, category } = req.body;

    if (!personImage || !clothingImage) {
      return res.status(400).json({ success: false, error: "Both User Photo and Cloth Image are required." });
    }

    let targetCategory = category;
    if (!targetCategory || targetCategory === 'auto') {
      targetCategory = detectGarmentCategory(clothingLink || clothingImage);
    }

    const humanImageUrl = await uploadToFal(personImage);
    const garmentImageUrl = await uploadToFal(clothingImage);

    // Free/Ad aur Paid sabhi ke liye FASHN 1.6 HD model
    const result = await fal.subscribe("fal-ai/fashn/tryon/v1.6", {
      input: {
        model_image: humanImageUrl,
        garment_image: garmentImageUrl,
        category: targetCategory,
        mode: "quality",
        garment_photo_type: "auto",
        nsfw_filter: true
      }
    });

    const finalResultUrl = result.data?.images?.[0]?.url || result.data?.image?.url;
    if (!finalResultUrl) throw new Error("AI returned empty result");

    return res.json({ 
      success: true, 
      resultImageUrl: finalResultUrl,
      appliedCategory: targetCategory
    });

  } catch (error) {
    console.error("TryOn Error:", error);
    return res.status(500).json({ success: false, error: error.message || "Failed to process AI Try-On" });
  }
});

// ==========================================
// 🔌 7. PORT LISTENER
// ==========================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ FitOut AI Backend running on port ${PORT}`);
});
