import express from 'express';
import cors from 'cors';
import multer from 'multer';
import dotenv from 'dotenv';
import { Client, handle_file } from "@gradio/client";
import jwt from 'jsonwebtoken';
import fs from 'fs';
import axios from 'axios';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

dotenv.config();

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const JWT_SECRET = process.env.JWT_SECRET || "fitout_ai_auth_key_2026";
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ==========================================
// 🗄️ 1. MONGODB ATLAS CONNECTION & SCHEMAS
// ==========================================
const MONGO_URI = process.env.MONGO_URI;

if (MONGO_URI) {
  mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB Atlas Connected Successfully!'))
    .catch((err) => console.error('❌ MongoDB Connection Error:', err));
} else {
  console.warn('⚠️ MONGO_URI not found in environment variables. Falling back to local mode.');
}

function getTodayString() {
  return new Date().toISOString().split('T')[0]; // Format: YYYY-MM-DD
}

// User Schema
const userSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true, trim: true },
  password: { type: String, required: true },
  name: { type: String, default: 'FitOut User' },
  credits: { type: Number, default: 2 },
  last_credit_date: { type: String, default: getTodayString },
  is_pro: { type: Boolean, default: true },
  ads_watched: { type: Number, default: 0 },
  processedTransactions: { type: [String], default: [] },
  created_at: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Catalog Schema
const catalogSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  title: String,
  category: String,
  tag: String,
  imageUrl: String,
  affiliateUrl: String,
  created_at: { type: Date, default: Date.now }
});

const Catalog = mongoose.model('Catalog', catalogSchema);

// Safe Daily Reset
function applyDailyCreditReset(user) {
  const today = getTodayString();
  if (user.last_credit_date !== today) {
    if ((user.credits || 0) < 2) {
      user.credits = 2;
    }
    user.last_credit_date = today;
    return true;
  }
  return false;
}

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

async function initCatalog() {
  try {
    const count = await Catalog.countDocuments();
    if (count === 0) {
      await Catalog.insertMany(INITIAL_CLOTHES);
      console.log('📦 Initial catalog seeded to MongoDB.');
    }
  } catch (e) {
    console.error('Catalog seed error:', e);
  }
}
mongoose.connection.once('open', initCatalog);

// ==========================================
// 👔 2. HANDPICKED CATALOG & ADMIN API
// ==========================================
app.get('/api/handpicked-clothes', async (req, res) => {
  try {
    let clothes = await Catalog.find().sort({ created_at: -1 });
    if (!clothes || clothes.length === 0) {
      clothes = INITIAL_CLOTHES;
    }
    res.json({ success: true, clothes });
  } catch (err) {
    res.json({ success: true, clothes: INITIAL_CLOTHES });
  }
});

const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET || "fitout_admin_secret_786";

app.post('/api/user/add-credits', async (req, res) => {
  try {
    const { userId, credits, transactionId } = req.body;
    if (!userId || !credits) {
      return res.status(400).json({ success: false, message: 'Missing parameters' });
    }

    let user = null;
    if (mongoose.isValidObjectId(userId)) {
      user = await User.findById(userId);
    }
    if (!user) {
      user = await User.findOne({ phone: String(userId).trim() });
    }

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (transactionId && user.processedTransactions?.includes(transactionId)) {
      return res.json({ success: true, credits: user.credits, message: 'Already processed' });
    }

    user.credits = (user.credits || 0) + Number(credits);
    if (transactionId) {
      user.processedTransactions.push(transactionId);
    }

    await user.save();
    return res.json({ success: true, credits: user.credits });
  } catch (err) {
    console.error('Error adding credits:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/user/restore-credits', async (req, res) => {
  try {
    const { userId, transactions } = req.body;
    if (!userId || !transactions || !Array.isArray(transactions)) {
      return res.status(400).json({ success: false, error: 'अमान्य डेटा' });
    }

    let user = null;
    if (mongoose.isValidObjectId(userId)) {
      user = await User.findById(userId);
    }
    if (!user) {
      user = await User.findOne({ phone: String(userId).trim() });
    }

    if (!user) {
      return res.status(404).json({ success: false, error: 'यूज़र रिकॉर्ड नहीं मिला।' });
    }

    if (!user.processedTransactions) {
      user.processedTransactions = [];
    }

    let addedCredits = 0;
    for (const tx of transactions) {
      const txId = tx.transactionIdentifier;
      const productId = tx.productIdentifier;

      if (txId && !user.processedTransactions.includes(txId)) {
        if (productId === 'credits_10') {
          addedCredits += 10;
        } else if (productId === 'credits_30') {
          addedCredits += 30;
        }
        user.processedTransactions.push(txId);
      }
    }

    if (addedCredits > 0) {
      user.credits = (user.credits || 0) + addedCredits;
      await user.save();
      return res.json({
        success: true,
        message: `${addedCredits} क्रेडिट्स सफलतापूर्वक रिस्टोर हो गए!`,
        credits: user.credits
      });
    } else {
      return res.json({
        success: false,
        error: 'कोई नया या अनक्लेम्ड पेमेंट नहीं मिला। आपके सभी क्रेडिट्स पहले से जुड़े हुए हैं।'
      });
    }
  } catch (error) {
    console.error('Restore Error:', error);
    res.status(500).json({ success: false, error: 'सर्वर पर रिस्टोर विफल रहा' });
  }
});

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

    const newCloth = new Catalog({
      id: 'hp_' + Date.now(),
      title: title.trim(),
      category: category || detectGarmentCategory(title),
      tag: tag || 'Trending',
      imageUrl: finalImageUrl,
      affiliateUrl: affiliateUrl || amazonUrl || '#'
    });

    await newCloth.save();

    return res.json({ 
      success: true, 
      message: "Product added to catalog successfully!", 
      item: newCloth 
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Failed to add cloth to catalog." });
  }
});

// ⚡ Accurate Category Detection (Tops ko pehle priority taaki shirt lamba na ho)
function detectGarmentCategory(urlOrText) {
  const text = (urlOrText || '').toLowerCase();

  const topKeywords = ['shirt', 't-shirt', 'tshirt', 'top', 'crop', 'hoodie', 'jacket', 'blazer', 'sweater', 'blouse', 'shrug', 'kurta', 'tunic', 'tee', 'polo'];
  if (topKeywords.some(k => text.includes(k))) {
    return 'tops';
  }

  const bottomKeywords = ['jeans', 'pant', 'trouser', 'shorts', 'skirt', 'jogger', 'legging', 'lower', 'trackpant', 'cargo'];
  if (bottomKeywords.some(k => text.includes(k)) && !text.includes('set') && !text.includes('suit')) {
    return 'bottoms';
  }

  const fullBodyKeywords = ['dress', 'frock', 'gown', 'jumpsuit', 'maxi', 'suit', 'kurti', 'co-ord', 'set', 'saree', 'lehenga', 'anarkali'];
  if (fullBodyKeywords.some(k => text.includes(k))) {
    return 'one-pieces';
  }

  return 'tops';
}

// ⚡ Aspect Ratio Detection
function getImageAspectRatio(base64Str) {
  try {
    if (!base64Str || typeof base64Str !== 'string') return 1.0;
    const clean = base64Str.includes(';base64,') ? base64Str.split(';base64,')[1] : base64Str;
    const buffer = Buffer.from(clean.slice(0, 4000), 'base64');

    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return height / width;
    }

    if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
      let i = 2;
      while (i < buffer.length - 8) {
        if (buffer[i] === 0xFF) {
          const marker = buffer[i + 1];
          if (marker >= 0xC0 && marker <= 0xC3) {
            const height = buffer.readUInt16BE(i + 5);
            const width = buffer.readUInt16BE(i + 7);
            return height / width;
          }
          i += 2 + buffer.readUInt16BE(i + 2);
        } else {
          i++;
        }
      }
    }
  } catch (e) {
    return 1.0;
  }
  return 1.0;
}

// ==========================================
// 🛍️ 3. SMART E-COMMERCE SCRAPER
// ==========================================
app.post('/api/extract-image', async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ success: false, message: 'URL is required' });

  try {
    url = decodeURIComponent(url).trim();
    const urlMatch = url.match(/(https?:\/\/[^\s]+)/i);
    if (urlMatch) url = urlMatch[0].trim();
    if (url.startsWith('//')) url = 'https:' + url;

    if (url.match(/\.(jpeg|jpg|png|webp|avif)($|\?)/i)) {
      return res.json({ success: true, imageUrl: url });
    }

    let finalUrl = url;
    let pageHtml = '';

    try {
      const response = await axios.get(url, {
        maxRedirects: 5,
        timeout: 9000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });
      finalUrl = response.request?.res?.responseUrl || url;
      pageHtml = typeof response.data === 'string' ? response.data : '';
    } catch (e) {
      console.warn("Direct page fetch failed:", e.message);
    }

    let extractedImage = null;

    const asinMatch = finalUrl.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    if ((finalUrl.includes('amazon') || url.includes('amzn')) && asinMatch && asinMatch[1]) {
      extractedImage = `https://images-na.ssl-images-amazon.com/images/P/${asinMatch[1]}.01.MAIN._SCRMZZZZZZ_.jpg`;
    }

    if (!extractedImage && pageHtml) {
      const ogMatch = pageHtml.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
                      pageHtml.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i) ||
                      pageHtml.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i) ||
                      pageHtml.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i);

      if (ogMatch && ogMatch[1]) {
        let img = ogMatch[1].trim();
        if (img.startsWith('//')) img = 'https:' + img;
        if (!img.toLowerCase().includes('logo') && !img.endsWith('.svg')) {
          extractedImage = img;
        }
      }
    }

    if (!extractedImage && finalUrl.includes('meesho.com')) {
      const meeshoMatch = finalUrl.match(/\/p\/([a-zA-Z0-9]+)/i);
      if (meeshoMatch && meeshoMatch[1]) {
        try {
          const meeshoRes = await axios.get(`https://www.meesho.com/api/v1/products/${meeshoMatch[1]}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 6000
          });
          const pData = meeshoRes.data;
          if (pData?.images?.length > 0) extractedImage = pData.images[0];
          else if (pData?.product_images?.length > 0) extractedImage = pData.product_images[0].url;
        } catch (e) {}
      }
    }

    if (!extractedImage) {
      try {
        const jinaRes = await axios.get(`https://r.jina.ai/${finalUrl}`, { timeout: 8000 });
        const mdText = typeof jinaRes.data === 'string' ? jinaRes.data : JSON.stringify(jinaRes.data);
        const imgMatches = mdText.match(/!\[.*?\]\((https?:\/\/[^\s\)]+)\)/gi);
        if (imgMatches && imgMatches.length > 0) {
          for (const m of imgMatches) {
            const singleUrl = m.match(/\((https?:\/\/[^\s\)]+)\)/)[1];
            const lower = singleUrl.toLowerCase();
            if (!lower.includes('logo') && !lower.includes('icon') && !lower.includes('badge') && !lower.endsWith('.svg')) {
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

    return res.status(404).json({ success: false, message: 'इस लिंक से फोटो नहीं मिल पाई। कृपया फोटो सीधे अपलोड करें।' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'URL प्रोसेस करने में सर्वर एरर आया।' });
  }
});

// ==========================================
// 👤 4. AUTHENTICATION & CLOUD PROFILE APIS
// ==========================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { phone, password, name } = req.body;
    if (!phone || !password) {
      return res.status(400).json({ success: false, message: 'मोबाइल नंबर और पासवर्ड आवश्यक हैं।' });
    }

    const cleanPhone = phone.trim();
    const existing = await User.findOne({ phone: cleanPhone });
    if (existing) {
      return res.status(400).json({ success: false, message: 'यह मोबाइल नंबर पहले से रजिस्टर्ड है। कृपया लॉगिन करें।' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({
      phone: cleanPhone,
      password: hashedPassword,
      name: name?.trim() || `User_${cleanPhone.slice(-4)}`,
      credits: 2,
      last_credit_date: getTodayString()
    });

    await newUser.save();

    const token = jwt.sign({ id: newUser._id, phone: newUser.phone }, JWT_SECRET, { expiresIn: '60d' });
    return res.json({
      success: true,
      message: 'रजिस्ट्रेशन सफल रहा!',
      token,
      user: {
        id: newUser._id,
        phone: newUser.phone,
        name: newUser.name,
        credits: newUser.credits
      }
    });
  } catch (err) {
    console.error('Register Error:', err);
    return res.status(500).json({ success: false, message: 'रजिस्ट्रेशन में सर्वर त्रुटि हुई।' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, identifier, password } = req.body;
    const userPhone = (phone || identifier || '').trim();

    if (!userPhone) {
      return res.status(400).json({ success: false, message: 'मोबाइल नंबर दर्ज करें।' });
    }

    const user = await User.findOne({ phone: userPhone });
    if (!user) {
      return res.status(404).json({ success: false, message: 'यह नंबर रजिस्टर्ड नहीं है। पहले साइन अप करें।' });
    }

    if (password) {
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return res.status(401).json({ success: false, message: 'गलत पासवर्ड! कृपया सही पासवर्ड डालें।' });
      }
    }

    if (applyDailyCreditReset(user)) {
      await user.save();
    }

    const token = jwt.sign({ id: user._id, phone: user.phone }, JWT_SECRET, { expiresIn: '60d' });
    return res.json({
      success: true,
      token,
      user: {
        id: user._id,
        phone: user.phone,
        name: user.name,
        credits: user.credits
      }
    });
  } catch (err) {
    console.error('Login Error:', err);
    return res.status(500).json({ success: false, message: 'लॉगिन में सर्वर त्रुटि हुई।' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { phone, newPassword } = req.body;
    if (!phone || !newPassword) {
      return res.status(400).json({ success: false, message: 'मोबाइल नंबर और नया पासवर्ड आवश्यक हैं।' });
    }

    const user = await User.findOne({ phone: phone.trim() });
    if (!user) {
      return res.status(404).json({ success: false, message: 'यह मोबाइल नंबर रिकॉर्ड में नहीं मिला।' });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    return res.json({ success: true, message: 'पासवर्ड सफलतापूर्वक बदल दिया गया! अब लॉगिन करें।' });
  } catch (err) {
    console.error('Reset Password Error:', err);
    return res.status(500).json({ success: false, message: 'पासवर्ड रीसेट नहीं हो सका।' });
  }
});

app.get('/api/user/profile', async (req, res) => {
  try {
    const userId = req.query.userId || req.headers['x-user-id'];
    if (!userId) {
      return res.status(400).json({ success: false, error: "User ID required" });
    }

    let user = null;
    if (mongoose.isValidObjectId(userId)) {
      user = await User.findById(userId);
    }
    if (!user) {
      user = await User.findOne({ phone: String(userId).trim() });
    }

    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    if (applyDailyCreditReset(user)) {
      await user.save();
    }

    return res.json({
      success: true,
      user: {
        id: user._id,
        phone: user.phone,
        name: user.name,
        credits: user.credits
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Profile fetch error" });
  }
});

app.post('/api/user/reward-ad', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }

    let user = null;
    if (mongoose.isValidObjectId(userId)) {
      user = await User.findById(userId);
    }
    if (!user) {
      user = await User.findOne({ phone: String(userId).trim() });
    }

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    applyDailyCreditReset(user);
    user.credits = (user.credits || 0) + 1;
    user.ads_watched = (user.ads_watched || 0) + 1;
    await user.save();

    return res.json({
      success: true,
      message: '+1 Credit successfully added to cloud!',
      credits: user.credits
    });
  } catch (err) {
    console.error('Reward Credit Error:', err);
    return res.status(500).json({ success: false, message: 'Reward credit update failed' });
  }
});

app.post('/api/buy-credits', (req, res) => {
  return res.json({
    success: false,
    message: "Google Play In-App Billing is active. Please purchase directly from the app."
  });
});

// ==========================================
// 👗 6. TRY-ON PIPELINE (HF IDM-VTON + Cloud Quota)
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
    const { personImage, clothingImage, clothingLink, category, userId } = req.body;

    if (!personImage || !clothingImage) {
      return res.status(400).json({ 
        success: false, 
        error: "Both User Photo and Cloth Image are required." 
      });
    }

    let user = null;
    if (userId) {
      if (mongoose.isValidObjectId(userId)) user = await User.findById(userId);
      if (!user) user = await User.findOne({ phone: String(userId).trim() });

      if (user) {
        applyDailyCreditReset(user);
        if (user.credits <= 0) {
          await user.save();
          return res.status(403).json({
            success: false,
            error: "आपके पास पर्याप्त क्रेडिट्स नहीं हैं! कृपया नए क्रेडिट्स खरीदें या Ad देखकर क्रेडिट पाएं।"
          });
        }
      }
    }

    // 🧠 Aspect Ratio और Category Logic (शर्ट को कमर तक रखने के लिए सुरक्षित जांच)
    const ratio = getImageAspectRatio(clothingImage);
    const detectedCategory = detectGarmentCategory(clothingLink || "");
    const finalCategory = category || detectedCategory;

    let targetPrompt = "A neat waist-length upper body shirt, top, t-shirt, short kurta, natural waistline outfit";

    // Dress sirf tab maanein jab category explicitly 'one-pieces' ho, YA ratio 1.55+ ho aur wo top na ho
    if (finalCategory === 'one-pieces' || (ratio >= 1.55 && finalCategory !== 'tops')) {
      targetPrompt = "A realistic full length one-piece dress, frock, kurti, gown, full body outfit";
      console.log(`👗 Full Body Dress Detected! Ratio: ${ratio.toFixed(2)}`);
    } else if (finalCategory === 'bottoms') {
      targetPrompt = "Lower body pants, jeans, trousers, shorts";
      console.log(`👖 Bottoms Detected! Ratio: ${ratio.toFixed(2)}`);
    } else {
      console.log(`👚 Upper Body Top Detected! Ratio: ${ratio.toFixed(2)}`);
    }

    console.log("Connecting to Hugging Face IDM-VTON...");

    const hfClient = await Client.connect("premcreative7/IDM-VTON", {
      hf_token: process.env.HF_TOKEN,
      token: process.env.HF_TOKEN
    });

    // 🛡️ Parameter 5 ko false kiya gaya hai taaki auto-crop zoom aur seams chehre/haathon ko kharab na karein
    const result = await hfClient.predict("/tryon", [
      { 
        background: prepareGradioFile(personImage),
        layers: [],
        composite: null 
      },
      prepareGradioFile(clothingImage),
      targetPrompt,
      true,  // is_checked (auto mask)
      false, // is_checked_crop (False rakhne se original framing, face aur hands safe rehte hain)
      30,    // denoise_steps
      42     // seed
    ]);

    const finalResultUrl = await convertOutputToBase64(result.data?.[0]);

    if (!finalResultUrl) {
      throw new Error("Could not extract generated image from AI response");
    }

    if (user) {
      user.credits = Math.max(0, user.credits - 1);
      await user.save();
      console.log(`Credit deducted. Remaining: ${user.credits}`);
    }

    return res.json({ 
      success: true, 
      resultImageUrl: finalResultUrl,
      appliedCategory: finalCategory,
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
