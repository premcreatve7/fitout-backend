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

// User Schema (Permanent Cloud Storage)
const userSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true, trim: true },
  password: { type: String, required: true },
  name: { type: String, default: 'FitOut User' },
  credits: { type: Number, default: 2 },
  last_credit_date: { type: String, default: getTodayString },
  is_pro: { type: Boolean, default: true },
  ads_watched: { type: Number, default: 0 },
  created_at: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Catalog Schema (Admin clothes persist across server restarts)
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

// Har user ke daily credits check aur reset karne ka helper function
function applyDailyCreditReset(user) {
  const today = getTodayString();
  if (user.last_credit_date !== today) {
    user.credits = 2; // Har nayi tarikh ko 2 free credits milenge
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

// Seed Catalog if empty in Mongo
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
    const { userId, credits } = req.body;
    if (!userId || !credits) {
      return res.status(400).json({ success: false, message: 'Missing parameters' });
    }

    // MongoDB me user dhoond kar credits badhayein
    const user = await User.findOneAndUpdate(
      { $or: [{ phone: userId }, { _id: userId }] },
      { $inc: { credits: Number(credits) } },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    return res.json({ success: true, credits: user.credits });
  } catch (err) {
    console.error('Error adding credits:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
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
// 👤 4. AUTHENTICATION & CLOUD PROFILE APIS
// ==========================================

// 1. REGISTER: Naya Account Banae
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

// 2. LOGIN: Asli Password Check Kare
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

    // Strict Password Verification
    if (password) {
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return res.status(401).json({ success: false, message: 'गलत पासवर्ड! कृपया सही पासवर्ड डालें।' });
      }
    }

    // Daily Credit Reset Check
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

// 3. RESET PASSWORD: Naya Password Set Kare
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

// 4. PROFILE & CREDIT SYNC (Phone Clear Data Safe)
// 4. PROFILE & CREDIT SYNC (Phone Clear Data Safe)
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
      user = await User.findOne({ phone: userId.trim() });
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

// ==========================================
// 🎁 REWARD AD CREDIT (MongoDB Cloud Sync)
// ==========================================
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

    // Daily reset check
    applyDailyCreditReset(user);

    // MongoDB Atlas me +1 Credit add karein
    user.credits = (user.credits || 0) + 1;
    user.ads_watched = (user.ads_watched || 0) + 1;
    await user.save();

    console.log(`🎁 Reward credit added for ${user.phone}. New balance: ${user.credits}`);

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


// ==========================================
// 💳 5. IN-APP PURCHASE LOCK (No Fake Credits)
// ==========================================
app.post('/api/buy-credits', (req, res) => {
  return res.json({
    success: false,
    message: "Purchase option agle update mein available hoga! Closed testing ke dauran aapko roz 2 free credits milenge."
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
    const { personImage, clothingImage, category, userId } = req.body;

    if (!personImage || !clothingImage) {
      return res.status(400).json({ 
        success: false, 
        error: "Both User Photo and Cloth Image are required." 
      });
    }

    // 🔒 1. Cloud Credit Check Logic
    let user = null;
    if (userId) {
      if (mongoose.isValidObjectId(userId)) {
        user = await User.findById(userId);
      }
      if (!user) {
        user = await User.findOne({ phone: String(userId).trim() });
      }

      if (user) {
        applyDailyCreditReset(user);
        if (user.credits <= 0) {
          await user.save();
          return res.status(403).json({
            success: false,
            error: "Aapka aaj ka free quota (2 credits) khatam ho chuka hai! Kal naye credits milenge."
          });
        }
      }
    }

    console.log("Try-on request received. Connecting to Hugging Face IDM-VTON...");

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

    // ✂️ 2. Cloud Database se 1 credit deduct karein
    if (user) {
      user.credits = Math.max(0, user.credits - 1);
      await user.save();
      console.log(`Credit deducted. Remaining for ${user.phone}: ${user.credits}`);
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
