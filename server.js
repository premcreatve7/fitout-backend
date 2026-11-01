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
import Razorpay from 'razorpay';
import crypto from 'crypto';

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
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "fitout_webhook_2026";

// ==========================================
// 💳 1. RAZORPAY INITIALIZATION
// ==========================================
let razorpay = null;
if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: RAZORPAY_KEY_ID,
    key_secret: RAZORPAY_KEY_SECRET,
  });
  console.log('✅ Razorpay Initialized!');
}

// ==========================================
// 🗄️ 2. MONGODB ATLAS & SCHEMAS
// ==========================================
const MONGO_URI = process.env.MONGO_URI;
if (MONGO_URI) {
  mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB Connected!'))
    .catch((err) => console.error('❌ MongoDB Connection Error:', err));
}

function getTodayString() {
  return new Date().toISOString().split('T')[0]; // Format: YYYY-MM-DD
}

// User Schema (Strict 1 Welcome Credit & DB-backed 24h Ad Tracking)
const userSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true, trim: true },
  password: { type: String, required: true },
  name: { type: String, default: 'FitOut User' },
  credits: { type: Number, default: 1 }, // ✅ Sirf 1 Free Welcome Credit
  has_claimed_welcome_credit: { type: Boolean, default: true },
  last_ad_reward_date: { type: String, default: '' }, // ✅ 24 ghante me 1 baar DB level check
  ads_watched_today: { type: Number, default: 0 },
  processedTransactions: { type: [String], default: [] }, // ✅ Replay prevention
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

// ==========================================
// 👗 3. HANDPICKED CATALOG & SEEDING (RESTORED)
// ==========================================
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

    const detected = detectGarmentCategory(title);

    const newCloth = new Catalog({
      id: 'hp_' + Date.now(),
      title: title.trim(),
      category: category || detected || 'tops',
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

// ==========================================
// 💳 4. RAZORPAY PAYMENT LINK & WEBHOOK
// ==========================================
app.post('/api/payment/create-link', async (req, res) => {
  try {
    if (!razorpay) return res.status(500).json({ success: false, message: 'Razorpay keys backend me configure nahi hain.' });

    const { amount, userId, planId, phone } = req.body;
    if (!amount || !userId) return res.status(400).json({ success: false, message: 'Amount aur User ID zaroori hain' });

    let customerData = undefined;
    if (phone) {
      const cleanPhone = String(phone).replace(/\D/g, '').slice(-10);
      if (cleanPhone.length === 10) customerData = { contact: `+91${cleanPhone}` };
    }

    const paymentLink = await razorpay.paymentLink.create({
      amount: Math.round(Number(amount) * 100),
      currency: 'INR',
      accept_partial: false,
      description: `${planId || 'credits'} - FitOut AI Try-On Credits`,
      customer: customerData,
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: {
        userId: String(userId),
        planId: String(planId || 'credits')
      },
      callback_url: `https://fitout-backend.onrender.com/api/payment/callback?userId=${encodeURIComponent(userId)}&amount=${amount}`,
      callback_method: 'get'
    });

    console.log(`🔗 Payment Link: ${paymentLink.short_url} | User: ${userId}`);
    return res.json({ success: true, paymentUrl: paymentLink.short_url, paymentId: paymentLink.id });
  } catch (error) {
    console.error('Create Link Error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 🚀 Razorpay Webhook (Direct Server-to-Server Credit Guarantee)
app.post('/api/payment/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const bodyStr = JSON.stringify(req.body);

    const expectedSignature = crypto
      .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
      .update(bodyStr)
      .digest('hex');

    if (signature !== expectedSignature) {
      console.warn("⚠️ Invalid Webhook Signature Rejected!");
      return res.status(400).send("Invalid Signature");
    }

    const event = req.body.event;

    if (event === 'payment_link.paid' || event === 'payment.captured') {
      const entity = req.body.payload.payment_link?.entity || req.body.payload.payment?.entity;
      const paymentId = entity?.id;
      const userId = entity?.notes?.userId;
      const amount = (entity?.amount || 4900) / 100;
      const creditsToAdd = amount >= 99 ? 30 : 10;

      if (userId) {
        let user = await User.findOne({ 
          $or: [{ phone: String(userId).trim() }, { _id: mongoose.isValidObjectId(userId) ? userId : null }] 
        });

        if (user) {
          if (!user.processedTransactions) user.processedTransactions = [];
          if (!user.processedTransactions.includes(paymentId)) {
            user.credits = (user.credits || 0) + creditsToAdd;
            if (paymentId) user.processedTransactions.push(paymentId);
            await user.save();
            console.log(`🚀 WEBHOOK SUCCESS: +${creditsToAdd} Credits added to ${user.phone}`);
          }
        }
      }
    }

    return res.json({ status: 'ok' });
  } catch (err) {
    console.error("Webhook processing error:", err);
    return res.status(500).send("Webhook Error");
  }
});

// Browser Return Callback
app.get('/api/payment/callback', async (req, res) => {
  try {
    const { userId, amount, razorpay_payment_id, razorpay_payment_link_status } = req.query;
    const creditsToAdd = Number(amount) >= 99 ? 30 : 10;

    if (razorpay_payment_link_status === 'paid' || razorpay_payment_id) {
      let user = await User.findOne({ 
        $or: [{ phone: String(userId).trim() }, { _id: mongoose.isValidObjectId(userId) ? userId : null }] 
      });

      if (user) {
        if (!user.processedTransactions) user.processedTransactions = [];
        if (!user.processedTransactions.includes(razorpay_payment_id)) {
          user.credits = (user.credits || 0) + creditsToAdd;
          if (razorpay_payment_id) user.processedTransactions.push(razorpay_payment_id);
          await user.save();
          console.log(`✅ Callback Success: +${creditsToAdd} Credits to ${user.phone}`);
        }
      }

      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Payment Successful</title>
          <style>
            body { font-family: -apple-system, sans-serif; text-align: center; padding: 40px 20px; background: #FAF7F2; }
            .card { background: white; border-radius: 24px; padding: 32px 24px; box-shadow: 0 10px 25px rgba(0,0,0,0.06); max-width: 360px; margin: 0 auto; }
            .icon { width: 56px; height: 56px; background: #DCFCE7; color: #16A34A; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 28px; margin: 0 auto 16px; font-weight: bold; }
            h2 { color: #1E293B; margin: 0 0 8px; font-size: 20px; font-weight: 800; }
            .badge { display: inline-block; background: #F3E8FF; color: #7E22CE; font-weight: 800; padding: 6px 14px; border-radius: 99px; margin: 12px 0; font-size: 13px; }
            p { color: #64748B; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="icon">✓</div>
            <h2>Payment Successful!</h2>
            <div class="badge">+${creditsToAdd} Credits Added</div>
            <p>FitOut AI app me wapas jayein, credits update ho chuke hain.</p>
          </div>
        </body>
        </html>
      `);
    } else {
      return res.send("<h2>Payment Incomplete hai. Kripya app me wapas jayein.</h2>");
    }
  } catch (error) {
    return res.status(500).send("Internal Server Error");
  }
});

// Fallback Standard Razorpay Order API
app.post('/api/payment/create-order', async (req, res) => {
  try {
    if (!razorpay) return res.status(500).json({ success: false, message: 'Razorpay keys missing.' });
    const { amount, planId, userId } = req.body;
    const order = await razorpay.orders.create({
      amount: Math.round(Number(amount) * 100),
      currency: 'INR',
      receipt: `rcpt_${Date.now()}_${String(userId).slice(-4)}`,
      notes: { userId: String(userId), planId: planId || 'credits_pack' }
    });
    return res.json({ success: true, orderId: order.id, amount: order.amount, currency: order.currency, keyId: RAZORPAY_KEY_ID });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Order generate nahi ho saka.' });
  }
});

// ==========================================
// 👤 5. AUTHENTICATION & PROFILE APIS
// ==========================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { phone, password, name } = req.body;
    if (!phone || !password) return res.status(400).json({ success: false, message: 'Details missing hain' });

    const cleanPhone = phone.trim();
    const existing = await User.findOne({ phone: cleanPhone });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Yeh number pehle se registered hai! Kripya Sign In karein.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({
      phone: cleanPhone,
      password: hashedPassword,
      name: name?.trim() || `User_${cleanPhone.slice(-4)}`,
      credits: 1, // ✅ Har naye number ko sirf 1 Free Credit
      has_claimed_welcome_credit: true,
      ads_watched_today: 0,
      last_ad_reward_date: ''
    });

    await newUser.save();

    const token = jwt.sign({ id: newUser._id, phone: newUser.phone }, JWT_SECRET, { expiresIn: '60d' });
    return res.json({
      success: true,
      message: 'Aapko 1 Free Try-On Credit mil gaya hai!',
      token,
      user: { id: newUser._id, phone: newUser.phone, name: newUser.name, credits: newUser.credits }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Registration error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, identifier, password } = req.body;
    const userPhone = (phone || identifier || '').trim();

    const user = await User.findOne({ phone: userPhone });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Yeh number registered nahi hai. Pehle Sign Up karein.' });
    }

    if (password) {
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) return res.status(401).json({ success: false, message: 'Galat password!' });
    }

    // Daily reset hata diya gaya hai - Database me jo original balance hai wahi aayega
    const token = jwt.sign({ id: user._id, phone: user.phone }, JWT_SECRET, { expiresIn: '60d' });
    return res.json({
      success: true,
      token,
      user: { id: user._id, phone: user.phone, name: user.name, credits: user.credits }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Login error' });
  }
});

app.get('/api/user/profile', async (req, res) => {
  try {
    const userId = req.query.userId || req.headers['x-user-id'];
    let user = await User.findOne({ 
      $or: [{ phone: String(userId).trim() }, { _id: mongoose.isValidObjectId(userId) ? userId : null }] 
    });

    if (!user) return res.status(404).json({ success: false, error: "User nahi mila" });

    return res.json({
      success: true,
      user: {
        id: user._id,
        phone: user.phone,
        name: user.name,
        credits: user.credits,
        adsWatched: user.last_ad_reward_date === getTodayString() ? 3 : (user.ads_watched_today || 0),
        canWatchAd: user.last_ad_reward_date !== getTodayString()
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Profile error" });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { phone, newPassword } = req.body;
    const user = await User.findOne({ phone: phone?.trim() });
    if (!user) return res.status(404).json({ success: false, message: 'User nahi mila' });
    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();
    return res.json({ success: true, message: 'Password badal diya gaya hai.' });
  } catch (e) {
    return res.status(500).json({ success: false, message: 'Password reset error' });
  }
});

// ==========================================
// 📺 6. 24-HOUR AD REWARD API (DB-Backed)
// ==========================================
app.post('/api/user/reward-ad', async (req, res) => {
  try {
    const { userId } = req.body;
    let user = await User.findOne({ 
      $or: [{ phone: String(userId).trim() }, { _id: mongoose.isValidObjectId(userId) ? userId : null }] 
    });

    if (!user) return res.status(404).json({ success: false, message: 'User nahi mila' });

    const today = getTodayString();

    if (user.last_ad_reward_date === today) {
      return res.status(400).json({ 
        success: false, 
        message: 'Aapne aaj ka free ad credit claim kar liya hai. Agle 24 ghante baad dubara try karein!' 
      });
    }

    user.ads_watched_today = (user.ads_watched_today || 0) + 1;

    if (user.ads_watched_today >= 3) {
      user.credits = (user.credits || 0) + 1;
      user.last_ad_reward_date = today;
      user.ads_watched_today = 0;
      await user.save();

      return res.json({
        success: true,
        completed: true,
        credits: user.credits,
        message: '🎉 3 Ads pure hue! +1 Credit jud gaya hai.'
      });
    } else {
      await user.save();
      return res.json({
        success: true,
        completed: false,
        adsWatched: user.ads_watched_today,
        message: `📺 Ad ${user.ads_watched_today}/3 dekha gaya!`
      });
    }
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Ad reward error' });
  }
});

// ==========================================
// 🛍️ 7. E-COMMERCE SCRAPER (RESTORED)
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
// 👗 8. UNIVERSAL CATEGORY & TRY-ON PIPELINE (SAFE DEDUCTION)
// ==========================================
function detectGarmentCategory(urlOrText) {
  if (!urlOrText || typeof urlOrText !== 'string' || !urlOrText.trim()) return null;
  const text = urlOrText.toLowerCase();

  const fullBodyKeywords = ['saree', 'sari', 'sadi', 'dress', 'frock', 'gown', 'jumpsuit', 'maxi', 'suit', 'kurti', 'co-ord', 'coord', 'set', 'lehenga', 'anarkali', 'robe', 'choli', 'combo', 'tracksuit'];
  if (fullBodyKeywords.some(k => text.includes(k))) return 'one-pieces';

  const bottomKeywords = ['jeans', 'pant', 'trouser', 'shorts', 'skirt', 'jogger', 'legging', 'lower', 'trackpant', 'cargo', 'palazzo', 'pyjama'];
  if (bottomKeywords.some(k => text.includes(k))) return 'bottoms';

  const topKeywords = ['shirt', 't-shirt', 'tshirt', 'top', 'crop', 'hoodie', 'jacket', 'blazer', 'sweater', 'blouse', 'shrug', 'kurta', 'tunic', 'tee', 'polo'];
  if (topKeywords.some(k => text.includes(k))) return 'tops';

  return null;
}

function getImageAspectRatio(base64Str) {
  try {
    if (!base64Str || typeof base64Str !== 'string') return 1.0;
    const clean = base64Str.includes(';base64,') ? base64Str.split(';base64,')[1] : base64Str;
    const buffer = Buffer.from(clean.slice(0, 4000), 'base64');
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return buffer.readUInt32BE(20) / buffer.readUInt32BE(16);
    return 1.0;
  } catch (e) { return 1.0; }
}

async function convertOutputToBase64(rawOutput) {
  try {
    const fileUrl = rawOutput?.url || (typeof rawOutput === 'string' && rawOutput.startsWith('http') ? rawOutput : null);
    if (fileUrl) {
      const headers = process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {};
      const response = await fetch(fileUrl, { headers });
      const arrayBuffer = await response.arrayBuffer();
      return `data:image/png;base64,${Buffer.from(arrayBuffer).toString('base64')}`;
    }
    return null;
  } catch (err) { return null; }
}

function prepareGradioFile(input) {
  if (typeof input === 'string') {
    if (input.startsWith('http')) return handle_file(input);
    const clean = input.includes(';base64,') ? input.split(';base64,')[1] : input;
    return handle_file(Buffer.from(clean, 'base64'));
  }
  return handle_file(input);
}

app.post('/api/tryon', async (req, res) => {
  try {
    const { personImage, clothingImage, clothingLink, category, userId } = req.body;
    if (!personImage || !clothingImage) return res.status(400).json({ success: false, error: "Photos missing hain" });

    let user = await User.findOne({ 
      $or: [{ phone: String(userId).trim() }, { _id: mongoose.isValidObjectId(userId) ? userId : null }] 
    });

    if (!user || (user.credits || 0) < 1) {
      return res.status(403).json({
        success: false,
        error: "Aapke paas credits khatam ho gaye hain! Kripya credits buy karein ya Ad dekh kar credit lein."
      });
    }

    const ratio = getImageAspectRatio(clothingImage);
    const detectedCategory = detectGarmentCategory(clothingLink || "");
    let finalCategory = category || detectedCategory || (ratio >= 1.35 ? 'one-pieces' : 'tops');

    let targetPrompt = finalCategory === 'one-pieces' 
      ? "A realistic full length one-piece saree, dress, kurti, gown, full body outfit"
      : "A neat waist-length upper body shirt, top, t-shirt, short kurta outfit";

    const hfClient = await Client.connect("premcreative7/IDM-VTON", {
      hf_token: process.env.HF_TOKEN,
      token: process.env.HF_TOKEN
    });

    const result = await hfClient.predict("/tryon", [
      { background: prepareGradioFile(personImage), layers: [], composite: null },
      prepareGradioFile(clothingImage),
      targetPrompt,
      true,
      false,
      30,
      42
    ]);

    const finalResultUrl = await convertOutputToBase64(result.data?.[0]);

    if (!finalResultUrl) {
      throw new Error("AI output generate nahi ho paya. Credit safe hai.");
    }

    // ✅ Generation pass hone par hi credit deduct hoga
    user.credits = Math.max(0, user.credits - 1);
    await user.save();
    console.log(`✨ AI TryOn Success! 1 Credit Deducted. Remaining: ${user.credits} for ${user.phone}`);

    return res.json({
      success: true,
      resultImageUrl: finalResultUrl,
      appliedCategory: finalCategory,
      remainingCredits: user.credits
    });

  } catch (error) {
    console.error("TryOn Error (No credit cut):", error.message);
    return res.status(500).json({ success: false, error: error.message || "AI processing fail ho gayi, credit nahi kata." });
  }
});

// ==========================================
// 🔌 9. PORT LISTENER
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 FitOut Server Running on Port ${PORT}`);
});
