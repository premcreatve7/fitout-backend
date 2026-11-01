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

// Webhook ke liye raw body zaroori hoti hai signature verify karne ke liye
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const JWT_SECRET = process.env.JWT_SECRET || "fitout_ai_auth_key_2026";
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "fitout_webhook_2026";

let razorpay = null;
if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: RAZORPAY_KEY_ID,
    key_secret: RAZORPAY_KEY_SECRET,
  });
  console.log('✅ Razorpay Initialized!');
}

// ==========================================
// 🗄️ MONGODB CONNECTION & SCHEMAS
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

// User Schema (Strict Free-Credit & Ad Tracking in DB)
const userSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true, trim: true },
  password: { type: String, required: true },
  name: { type: String, default: 'FitOut User' },
  credits: { type: Number, default: 1 }, // ✅ Sirf 1 Free Credit milega signup par
  has_claimed_welcome_credit: { type: Boolean, default: true },
  last_ad_reward_date: { type: String, default: '' }, // ✅ Database me track hoga taaki data clear se bypass na ho
  ads_watched_today: { type: Number, default: 0 },
  processedTransactions: { type: [String], default: [] }, // ✅ Replay prevention
  created_at: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

const Catalog = mongoose.model('Catalog', new mongoose.Schema({
  id: { type: String, unique: true },
  title: String,
  category: String,
  tag: String,
  imageUrl: String,
  affiliateUrl: String,
  created_at: { type: Date, default: Date.now }
}));

// ==========================================
// 💳 RAZORPAY PAYMENT LINK & WEBHOOK (Permanent Fix)
// ==========================================

// 1. Create Payment Link
app.post('/api/payment/create-link', async (req, res) => {
  try {
    if (!razorpay) return res.status(500).json({ success: false, message: 'Razorpay configured nahi hai.' });

    const { amount, userId, planId, phone } = req.body;
    if (!amount || !userId) return res.status(400).json({ success: false, message: 'Details missing hain' });

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

// 2. Razorpay Webhook (SERVER-TO-SERVER GUARANTEE)
// Agar user payment ke turant baad app ya browser band kar de, toh bhi credits add honge
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
            console.log(`🚀 WEBHOOK SUCCESS: +${creditsToAdd} Credits added to user ${user.phone}`);
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

// 3. Browser Return Callback
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

// ==========================================
// 👤 AUTHENTICATION (NO DAILY RESET - STRICT 1 CREDIT ON SIGNUP)
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
      credits: 1, // ✅ Har naye number ko sirf 1 free credit
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

    // NOTE: Daily reset poori tarah hata diya hai. Database me jo credits hain wahi rahenge!
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

// ==========================================
// 📺 24-HOUR AD REWARD API (Strict MongoDB-Backed)
// ==========================================
app.post('/api/user/reward-ad', async (req, res) => {
  try {
    const { userId } = req.body;
    let user = await User.findOne({ 
      $or: [{ phone: String(userId).trim() }, { _id: mongoose.isValidObjectId(userId) ? userId : null }] 
    });

    if (!user) return res.status(404).json({ success: false, message: 'User nahi mila' });

    const today = getTodayString();

    // Agar aaj ka reward pehle hi le chuka hai
    if (user.last_ad_reward_date === today) {
      return res.status(400).json({ 
        success: false, 
        message: 'Aapne aaj ka free ad credit claim kar liya hai. Agle 24 ghante baad dubara try karein!' 
      });
    }

    user.ads_watched_today = (user.ads_watched_today || 0) + 1;

    // 3 Ads complete hone par 1 credit milega
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
// 👗 TRY-ON PIPELINE (Safe: Deduct ONLY on Success)
// ==========================================
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

    // 1. Credit Check: Kam se kam 1 credit hona chahiye
    if (!user || (user.credits || 0) < 1) {
      return res.status(403).json({
        success: false,
        error: "Aapke paas credits khatam ho gaye hain! Kripya credits buy karein ya Ad dekh kar credit lein."
      });
    }

    const ratio = getImageAspectRatio(clothingImage);
    let finalCategory = category || (ratio >= 1.35 ? 'one-pieces' : 'tops');
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
      // ⚠️ AI fail hua - Credit NAHI KATEGA
      throw new Error("AI output generate nahi ho paya. Credit safe hai.");
    }

    // ✅ 2. Successful generation ke baad hi credit deduct hoga!
    user.credits = Math.max(0, user.credits - 1);
    await user.save();
    console.log(`✨ AI TryOn Success! 1 Credit Deducted. Remaining: ${user.credits} for ${user.phone}`);

    return res.json({
      success: true,
      resultImageUrl: finalResultUrl,
      remainingCredits: user.credits
    });

  } catch (error) {
    console.error("TryOn Error (No credit cut):", error.message);
    // ⚠️ Agar processing me koi bhi error aaya, toh user ka credit bilkul safe rahega
    return res.status(500).json({ success: false, error: error.message || "AI processing fail ho gayi, credit nahi kata." });
  }
});

// App listen & helpers
app.post('/api/auth/reset-password', async (req, res) => {
  const { phone, newPassword } = req.body;
  const user = await User.findOne({ phone: phone?.trim() });
  if (!user) return res.status(404).json({ success: false, message: 'User nahi mila' });
  user.password = await bcrypt.hash(newPassword, 10);
  await user.save();
  res.json({ success: true, message: 'Password badal diya gaya hai.' });
});

app.get('/api/handpicked-clothes', async (req, res) => {
  const clothes = await Catalog.find().sort({ created_at: -1 });
  res.json({ success: true, clothes });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 FitOut Server Running on Port ${PORT}`));
