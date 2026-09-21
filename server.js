const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const crypto = require('crypto');
const supabase = require('./db');
const { getEmailSettings, sendOtpEmail } = require('./mailer');

const app = express();
const PORT = process.env.PORT || 3000;
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

// Helper Get & Save Settings (Tersinkronisasi Permanen ke Supabase Cloud)
async function getSettings() {
  try {
    const { data } = await supabase
      .from('customers')
      .select('visit_checklist')
      .eq('customer_code', 'SYSTEM_SETTINGS')
      .single();
    if (data && data.visit_checklist) {
      return data.visit_checklist;
    }
  } catch (e) {}

  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch (e) {}
  }
  return {
    adminWhatsapp: '081234567890',
    merchantName: 'WBnetwork RT/RW Net',
    paymentMethods: [],
    smtp: {
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      user: '',
      pass: '',
      from: 'WBnetwork Billing <no-reply@wbnetwork.id>'
    }
  };
}

async function saveSettings(settings) {
  try {
    await supabase
      .from('customers')
      .upsert({
        customer_code: 'SYSTEM_SETTINGS',
        name: '__SYSTEM_SETTINGS__',
        visit_checklist: settings
      }, { onConflict: 'customer_code' });
  } catch (e) {
    console.error("Supabase settings upsert error:", e.message);
  }

  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) {}
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.use(express.static(__dirname, { index: false }));

// Helper Pemformat Data
function formatResponse(customer, listTagihan = [], listTiket = []) {
  const tagihan = listTagihan && listTagihan.length > 0 ? listTagihan[0] : null;
  const tiketAktif = listTiket && listTiket.length > 0 ? listTiket[0] : null;

  const pkg = customer.package_name || customer.paket || '20 Mbps Home Fiber';
  const price = (tagihan && tagihan.nominal) || customer.monthly_price || 200000;
  const due = (tagihan && (tagihan.jatuh_tempo || tagihan.jatuhTempo)) || customer.due_day || '10';
  const v = customer.visit_checklist || {};

  return {
    success: true,
    data: {
      id: customer.customer_code,
      customer_code: customer.customer_code,
      name: customer.name,
      email: v.email || null,
      whatsapp: customer.whatsapp || null,
      nik: customer.nik || null,
      status: customer.customer_status || customer.status || 'aktif',
      connection_status: customer.connection_status || customer.status_koneksi || 'online',
      package: pkg,
      package_name: pkg,
      address: customer.address || customer.alamat || 'Alamat tidak diisi',
      location_note: customer.location_note || '',
      monthly_price: price,
      due_day: due,
      visit_checklist: v,
      
      tagihan: tagihan ? {
        bulan: tagihan.bulan,
        nominal: tagihan.nominal,
        status: tagihan.status,
        jatuhTempo: tagihan.jatuh_tempo || tagihan.jatuhTempo,
      } : {
        bulan: 'Bulan Ini',
        nominal: price,
        status: v.payment_status || 'Belum Lunas',
        jatuhTempo: due
      },
      tiketAktif: tiketAktif ? {
        idTiket: tiketAktif.id_tiket || tiketAktif.idTiket,
        kendala: tiketAktif.kendala,
        status: tiketAktif.status,
        teknisi: tiketAktif.teknisi
      } : null
    }
  };
}

// 1. Tampilan Halaman Utama Portal Pelanggan
app.get(['/', '/pelanggan', '/pelanggan.html', '/customer', '/customer.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'customer.html'));
});

// Tampilan Dashboard Admin & Teknisi
app.get(['/admin', '/admin.html', '/app', '/app.html', '/dashboard'], (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// 2. AUTHENTICATION (EMAIL & OTP PELANGGAN)
// ==========================================

// A. Kirim OTP untuk Registrasi Email Pelanggan
app.post('/api/auth/register-send-otp', async (req, res) => {
  const { customerCode, email, whatsapp, verificationKey } = req.body;

  if (!customerCode || !email) {
    return res.status(400).json({ success: false, message: "ID Pelanggan dan Email wajib diisi." });
  }

  const cleanEmail = email.toLowerCase().trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(cleanEmail)) {
    return res.status(400).json({ success: false, message: "Format alamat email tidak valid." });
  }

  const phoneInput = (whatsapp || verificationKey || '').trim();

  try {
    // 1. Cari pelanggan berdasarkan customer_code
    const { data: listCustomers, error: errCust } = await supabase
      .from('customers')
      .select('*')
      .eq('customer_code', customerCode.toUpperCase().trim())
      .limit(1);

    if (errCust) throw errCust;
    const customer = listCustomers && listCustomers[0];

    if (!customer) {
      return res.status(404).json({ success: false, message: `ID Pelanggan '${customerCode}' tidak ditemukan.` });
    }

    const v = customer.visit_checklist || {};

    // 2. Validasi kecocokan jika data di DB sudah ada
    if (phoneInput) {
      const vKeyClean = phoneInput.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      const dbWaClean = (customer.whatsapp || '').replace(/[^0-9]/g, '');
      const dbNikClean = (customer.nik || '').replace(/[^0-9]/g, '');
      const dbNameClean = (customer.name || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

      let match = false;
      if (dbWaClean && (dbWaClean.includes(vKeyClean) || vKeyClean.includes(dbWaClean))) match = true;
      if (dbNikClean && (dbNikClean.includes(vKeyClean) || vKeyClean.includes(dbNikClean))) match = true;
      if (dbNameClean && (dbNameClean.includes(vKeyClean) || vKeyClean.includes(dbNameClean))) match = true;

      // Jika data WA/NIK di DB masih kosong, jadikan nomor ini sebagai data pendaftar baru
      if (!dbWaClean && !dbNikClean) match = true;

      if (!match && dbWaClean) {
        return res.status(400).json({
          success: false,
          message: "Nomor WhatsApp/HP tidak sesuai dengan data terdaftar pada ID Pelanggan ini."
        });
      }
    }

    // 3. Generate 6 Digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 menit

    v.pending_email_reg = {
      email: cleanEmail,
      whatsapp: phoneInput || customer.whatsapp || null,
      otp,
      expiresAt
    };

    const { error: updErr } = await supabase
      .from('customers')
      .update({ visit_checklist: v })
      .eq('customer_code', customer.customer_code);

    if (updErr) throw updErr;

    // 4. Kirim Email OTP
    const mailRes = await sendOtpEmail(cleanEmail, otp, customer.name, 'register');

    res.json({
      success: true,
      message: mailRes.simulated
        ? `Mode Simulasi Aktif: Kode OTP Anda adalah [ ${otp} ]. (Atur akun Gmail di Admin Setting agar terkirim ke email sungguhan).`
        : `Kode OTP 6-digit berhasil dikirim ke ${cleanEmail}. Silakan cek kotak masuk/spam email Anda.`,
      simulated: mailRes.simulated || false,
      debugOtp: mailRes.simulated ? otp : undefined
    });
  } catch (err) {
    console.error("Register OTP Error:", err);
    res.status(500).json({ success: false, message: err.message || "Gagal mengirim OTP." });
  }
});

// B. Verifikasi OTP Registrasi & Simpan Email + Nomor WhatsApp ke Akun
app.post('/api/auth/register-verify-otp', async (req, res) => {
  const { customerCode, otp } = req.body;

  if (!customerCode || !otp) {
    return res.status(400).json({ success: false, message: "ID Pelanggan dan Kode OTP wajib diisi." });
  }

  try {
    const { data: listCustomers, error: errCust } = await supabase
      .from('customers')
      .select('*')
      .eq('customer_code', customerCode.toUpperCase().trim())
      .limit(1);

    if (errCust) throw errCust;
    const customer = listCustomers && listCustomers[0];

    if (!customer) {
      return res.status(404).json({ success: false, message: "Pelanggan tidak ditemukan." });
    }

    const v = customer.visit_checklist || {};
    const pending = v.pending_email_reg;

    if (!pending || !pending.otp) {
      return res.status(400).json({ success: false, message: "Tidak ada permintaan OTP registrasi yang aktif. Silakan minta OTP baru." });
    }

    if (Date.now() > pending.expiresAt) {
      return res.status(400).json({ success: false, message: "Kode OTP telah kadaluarsa. Silakan minta kode OTP baru." });
    }

    if (pending.otp.trim() !== otp.trim()) {
      return res.status(400).json({ success: false, message: "Kode OTP salah! Periksa kembali email Anda." });
    }

    // Sukses: Ikat email ke akun, simpan No WA ke DB jika ada, & buat session token
    const verifiedEmail = pending.email;
    const phoneToSave = pending.whatsapp || customer.whatsapp;
    const sessionToken = crypto.randomBytes(32).toString('hex');

    v.email = verifiedEmail;
    v.email_verified_at = new Date().toISOString();
    v.session_token = sessionToken;
    delete v.pending_email_reg;

    const updatePayload = {
      visit_checklist: v,
      verification_status: 'Sudah diverifikasi',
      updated_at: new Date().toISOString()
    };
    if (phoneToSave) {
      updatePayload.whatsapp = phoneToSave;
    }

    const { error: updErr } = await supabase
      .from('customers')
      .update(updatePayload)
      .eq('customer_code', customer.customer_code);

    if (updErr) throw updErr;

    customer.whatsapp = phoneToSave || customer.whatsapp;
    customer.visit_checklist = v;

    const { data: listTagihan } = await supabase.from('tagihan').select('*').eq('id_pelanggan', customer.customer_code).order('id', { ascending: false }).limit(1);
    const { data: listTiket } = await supabase.from('tiket').select('*').eq('id_pelanggan', customer.customer_code).order('id', { ascending: false }).limit(1);

    res.json({
      success: true,
      message: "Registrasi email berhasil! Anda telah masuk ke portal.",
      token: sessionToken,
      customer: formatResponse(customer, listTagihan, listTiket).data
    });
  } catch (err) {
    console.error("Verify Register OTP Error:", err);
    res.status(500).json({ success: false, message: err.message || "Gagal verifikasi OTP." });
  }
});

// C. Kirim OTP untuk Login Pelanggan Terdaftar
app.post('/api/auth/login-send-otp', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ success: false, message: "Email wajib diisi." });
  }

  const cleanEmail = email.toLowerCase().trim();

  try {
    // Cari pelanggan yang emailnya cocok
    const { data: allCustomers, error: errCust } = await supabase
      .from('customers')
      .select('*')
      .neq('customer_code', 'SYSTEM_SETTINGS');

    if (errCust) throw errCust;

    const customer = (allCustomers || []).find(c => {
      const v = c.visit_checklist || {};
      return (v.email && v.email.toLowerCase().trim() === cleanEmail);
    });

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: `Email '${cleanEmail}' belum terdaftar. Silakan pilih tab 'Daftar Akun Baru' untuk mendaftarkan email Anda.`
      });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 menit

    const v = customer.visit_checklist || {};
    v.login_otp = {
      otp,
      expiresAt
    };

    const { error: updErr } = await supabase
      .from('customers')
      .update({ visit_checklist: v })
      .eq('customer_code', customer.customer_code);

    if (updErr) throw updErr;

    const mailRes = await sendOtpEmail(cleanEmail, otp, customer.name, 'login');

    res.json({
      success: true,
      message: mailRes.simulated
        ? `Mode Simulasi Aktif: Kode OTP Anda adalah [ ${otp} ]. (Atur akun Gmail di Admin Setting agar terkirim ke email sungguhan).`
        : `Kode OTP 6-digit telah dikirim ke ${cleanEmail}. Periksa inbox atau spam email Anda.`,
      email: cleanEmail,
      simulated: mailRes.simulated || false,
      debugOtp: mailRes.simulated ? otp : undefined
    });
  } catch (err) {
    console.error("Login OTP Error:", err);
    res.status(500).json({ success: false, message: err.message || "Gagal mengirim OTP login." });
  }
});

// D. Verifikasi OTP Login & Masuk Portal
app.post('/api/auth/login-verify-otp', async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ success: false, message: "Email dan Kode OTP wajib diisi." });
  }

  const cleanEmail = email.toLowerCase().trim();

  try {
    const { data: allCustomers, error: errCust } = await supabase
      .from('customers')
      .select('*')
      .neq('customer_code', 'SYSTEM_SETTINGS');

    if (errCust) throw errCust;

    const customer = (allCustomers || []).find(c => {
      const v = c.visit_checklist || {};
      return (v.email && v.email.toLowerCase().trim() === cleanEmail);
    });

    if (!customer) {
      return res.status(404).json({ success: false, message: "Akun dengan email ini tidak ditemukan." });
    }

    const v = customer.visit_checklist || {};
    const loginOtp = v.login_otp;

    if (!loginOtp || !loginOtp.otp) {
      return res.status(400).json({ success: false, message: "Tidak ada permintaan login yang aktif. Silakan minta kode OTP baru." });
    }

    if (Date.now() > loginOtp.expiresAt) {
      return res.status(400).json({ success: false, message: "Kode OTP telah kadaluarsa. Silakan minta kode OTP baru." });
    }

    if (loginOtp.otp.trim() !== otp.trim()) {
      return res.status(400).json({ success: false, message: "Kode OTP salah! Periksa kembali email Anda." });
    }

    // Sukses: Buat Session Token baru
    const sessionToken = crypto.randomBytes(32).toString('hex');
    v.session_token = sessionToken;
    delete v.login_otp;

    const { error: updErr } = await supabase
      .from('customers')
      .update({ visit_checklist: v })
      .eq('customer_code', customer.customer_code);

    if (updErr) throw updErr;

    const { data: listTagihan } = await supabase.from('tagihan').select('*').eq('id_pelanggan', customer.customer_code).order('id', { ascending: false }).limit(1);
    const { data: listTiket } = await supabase.from('tiket').select('*').eq('id_pelanggan', customer.customer_code).order('id', { ascending: false }).limit(1);

    res.json({
      success: true,
      message: "Login berhasil!",
      token: sessionToken,
      customer: formatResponse(customer, listTagihan, listTiket).data
    });
  } catch (err) {
    console.error("Verify Login OTP Error:", err);
    res.status(500).json({ success: false, message: err.message || "Gagal verifikasi OTP." });
  }
});

// E. Cek Session Token Pelanggan (Auto Login / Auth Check)
app.get('/api/auth/me', async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = (authHeader && authHeader.startsWith('Bearer ')) ? authHeader.slice(7) : req.query.token;

  if (!token) {
    return res.status(401).json({ success: false, message: "Sesi tidak valid / belum login." });
  }

  try {
    const { data: allCustomers, error: errCust } = await supabase
      .from('customers')
      .select('*')
      .neq('customer_code', 'SYSTEM_SETTINGS');

    if (errCust) throw errCust;

    const customer = (allCustomers || []).find(c => {
      const v = c.visit_checklist || {};
      return (v.session_token && v.session_token === token);
    });

    if (!customer) {
      return res.status(401).json({ success: false, message: "Sesi telah berakhir atau tidak valid." });
    }

    const { data: listTagihan } = await supabase.from('tagihan').select('*').eq('id_pelanggan', customer.customer_code).order('id', { ascending: false }).limit(1);
    const { data: listTiket } = await supabase.from('tiket').select('*').eq('id_pelanggan', customer.customer_code).order('id', { ascending: false }).limit(1);

    res.json(formatResponse(customer, listTagihan, listTiket));
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// F. Logout Pelanggan
app.post('/api/auth/logout', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.json({ success: true, message: "Logged out." });

  try {
    const { data: allCustomers } = await supabase.from('customers').select('*');
    const customer = (allCustomers || []).find(c => {
      const v = c.visit_checklist || {};
      return (v.session_token === token);
    });

    if (customer) {
      const v = customer.visit_checklist || {};
      delete v.session_token;
      await supabase.from('customers').update({ visit_checklist: v }).eq('customer_code', customer.customer_code);
    }

    res.json({ success: true, message: "Logout berhasil." });
  } catch (err) {
    res.json({ success: true, message: "Logged out." });
  }
});

// ==========================================
// 3. HANDLER DATA PELANGGAN & SETTINGS
// ==========================================

// Handler API Data Pelanggan (Untuk Admin)
app.get(['/api/pelanggan/:id', '/pelanggan/data/:id', '/api/customer/:id'], async (req, res) => {
  let id = req.params.id || req.query.id;

  if (!id || id.endsWith('.html') || id === 'customer' || id === 'pelanggan') {
    return res.status(400).json({ success: false, message: "ID/Nama Pelanggan tidak valid" });
  }

  try {
    const cleanDigits = id.replace(/[^0-9]/g, '');
    let filterQuery = `customer_code.ilike.%${id}%,name.ilike.%${id}%`;
    
    if (cleanDigits.length >= 4) {
      filterQuery += `,whatsapp.ilike.%${cleanDigits}%`;
    }

    const { data: listCustomers, error: errCust } = await supabase
      .from('customers')
      .select('*')
      .neq('customer_code', 'SYSTEM_SETTINGS')
      .or(filterQuery)
      .limit(1);

    if (errCust) {
      console.error("❌ [SUPABASE ERROR]:", errCust.message);
    }

    const customer = listCustomers && listCustomers.length > 0 ? listCustomers[0] : null;

    if (!customer) {
      return res.status(404).json({ success: false, message: "Pelanggan tidak ditemukan" });
    }

    const code = customer.customer_code;
    const { data: listTagihan } = await supabase.from('tagihan').select('*').eq('id_pelanggan', code).order('id', { ascending: false }).limit(1);
    const { data: listTiket } = await supabase.from('tiket').select('*').eq('id_pelanggan', code).order('id', { ascending: false }).limit(1);

    res.json(formatResponse(customer, listTagihan, listTiket));
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Update Data Pelanggan (Termasuk Email & WhatsApp oleh Admin)
app.put('/api/customers/:code', async (req, res) => {
  const code = req.params.code;
  const { name, whatsapp, nik, address, location_note, package_name, monthly_price, due_day, email, customer_status } = req.body;

  try {
    const { data: currentCust, error: getErr } = await supabase
      .from('customers')
      .select('*')
      .eq('customer_code', code)
      .single();

    if (getErr || !currentCust) {
      return res.status(404).json({ success: false, message: "Pelanggan tidak ditemukan" });
    }

    const v = currentCust.visit_checklist || {};
    if (email !== undefined) {
      v.email = email ? email.toLowerCase().trim() : null;
    }

    const updatePayload = {
      name: name !== undefined ? name : currentCust.name,
      whatsapp: whatsapp !== undefined ? whatsapp : currentCust.whatsapp,
      nik: nik !== undefined ? nik : currentCust.nik,
      address: address !== undefined ? address : currentCust.address,
      location_note: location_note !== undefined ? location_note : currentCust.location_note,
      package_name: package_name !== undefined ? package_name : currentCust.package_name,
      monthly_price: monthly_price !== undefined ? parseInt(monthly_price, 10) : currentCust.monthly_price,
      due_day: due_day !== undefined ? String(due_day) : currentCust.due_day,
      customer_status: customer_status !== undefined ? customer_status : currentCust.customer_status,
      visit_checklist: v,
      updated_at: new Date().toISOString()
    };

    const { data: updated, error: updErr } = await supabase
      .from('customers')
      .update(updatePayload)
      .eq('customer_code', code)
      .select()
      .single();

    if (updErr) throw updErr;

    res.json({ success: true, message: "Data pelanggan berhasil diperbarui!", data: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// API Settings
app.get('/api/settings', async (req, res) => {
  const settings = await getSettings();
  res.json({ success: true, data: settings });
});

app.post('/api/settings', async (req, res) => {
  try {
    const current = await getSettings();
    const updated = { ...current, ...req.body };
    await saveSettings(updated);
    res.json({ success: true, message: "Pengaturan berhasil disimpan!", data: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Test Kirim Email SMTP
app.post('/api/test-email', async (req, res) => {
  const { targetEmail } = req.body;
  if (!targetEmail) {
    return res.status(400).json({ success: false, message: "Masukkan email tujuan uji coba." });
  }

  try {
    const testOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const result = await sendOtpEmail(targetEmail, testOtp, 'Admin WBnetwork (Test)', 'login');
    res.json({
      success: true,
      message: result.simulated
        ? `Mode Simulasi Aktif: Kode OTP [ ${testOtp} ] dicatat di server. (Isi Email & Sandi Aplikasi Gmail di form atas untuk mengirim email sungguhan).`
        : `Email uji coba berhasil dikirim ke ${targetEmail}!`,
      data: result
    });
  } catch (err) {
    res.status(500).json({ success: false, message: `Gagal mengirim email: ${err.message}` });
  }
});

// Legacy Payment Methods compatibility
app.get('/api/payment-methods', async (req, res) => {
  const settings = await getSettings();
  res.json({ success: true, data: settings.paymentMethods || [] });
});

app.post('/api/payment-methods', async (req, res) => {
  try {
    const settings = await getSettings();
    settings.paymentMethods = req.body;
    await saveSettings(settings);
    res.json({ success: true, message: "Metode pembayaran berhasil disimpan!", data: req.body });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// API Konfirmasi Pembayaran oleh Pelanggan
app.post('/api/confirm-payment', async (req, res) => {
  const { customerCode, method, amount, invoiceNo } = req.body;
  if (!customerCode) {
    return res.status(400).json({ success: false, message: "ID Pelanggan tidak boleh kosong" });
  }

  try {
    const { data: custData, error: custErr } = await supabase
      .from('customers')
      .select('*')
      .eq('customer_code', customerCode)
      .single();

    if (custErr || !custData) {
      return res.status(404).json({ success: false, message: "Pelanggan tidak ditemukan" });
    }

    const v = custData.visit_checklist || {};
    v.payment_status = 'Menunggu Konfirmasi';
    v.payment_method = method || 'QRIS / Transfer';
    v.payment_amount = amount || custData.monthly_price;
    v.payment_date = new Date().toISOString().slice(0, 10);
    v.invoice_no = invoiceNo || `INV-${Date.now()}`;
    v.pending_approval = true;

    const { error: updErr } = await supabase
      .from('customers')
      .update({ visit_checklist: v })
      .eq('customer_code', customerCode);

    if (updErr) throw updErr;

    res.json({
      success: true,
      message: "Konfirmasi pembayaran berhasil tersimpan!",
      data: v
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 1-Klik Setujui Lunas via WhatsApp Link untuk Admin
app.get('/api/approve-payment/:code', async (req, res) => {
  const code = req.params.code;
  const method = req.query.method || 'Transfer';

  try {
    const { data: custData, error: custErr } = await supabase
      .from('customers')
      .select('*')
      .eq('customer_code', code)
      .single();

    if (custErr || !custData) {
      return res.send(`<h2>Pelanggan ${code} tidak ditemukan</h2>`);
    }

    const v = custData.visit_checklist || {};
    v.payment_status = 'Lunas';
    v.payment_method = method;
    v.payment_date = new Date().toISOString().slice(0, 10);
    v.pending_approval = false;

    await supabase.from('customers').update({ visit_checklist: v }).eq('customer_code', code);

    res.send(`
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Status Pembayaran Lunas</title>
        <style>
          body { font-family: sans-serif; text-align: center; padding: 40px 20px; background: #f8fafc; color: #0f172a; }
          .card { background: white; padding: 30px; border-radius: 16px; max-width: 420px; margin: auto; box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
          .btn { display: inline-block; padding: 10px 20px; background: #2563eb; color: white; border-radius: 10px; text-decoration: none; font-weight: bold; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div style="font-size: 50px">✅</div>
          <h2 style="color: #059669; margin: 10px 0">PEMBAYARAN DIVERIFIKASI!</h2>
          <p>Tagihan untuk <b>${custData.name}</b> (${custData.customer_code}) telah berhasil ditandai <b>LUNAS</b> via ${method}.</p>
          <a href="/admin" class="btn">Buka Dashboard Admin</a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send(`Terjadi kesalahan: ${err.message}`);
  }
});

// API Lapor Gangguan
app.post(['/api/lapor', '/lapor'], async (req, res) => {
  const { idPelanggan, kendala } = req.body;
  if (!idPelanggan || !kendala) {
    return res.status(400).json({ success: false, message: "Data laporan tidak lengkap" });
  }

  const idTiket = `TK-${Math.floor(1000 + Math.random() * 9000)}`;

  try {
    const { data: cust } = await supabase
      .from('customers')
      .select('visit_checklist')
      .eq('customer_code', idPelanggan)
      .single();

    if (cust) {
      const v = cust.visit_checklist || {};
      if (!v.tickets) v.tickets = [];
      v.tickets.unshift({
        id_tiket: idTiket,
        kendala,
        status: 'Menunggu Teknisi',
        tanggal: new Date().toISOString()
      });
      await supabase.from('customers').update({ visit_checklist: v }).eq('customer_code', idPelanggan);
    }

    res.json({
      success: true,
      message: "Laporan tersimpan",
      tiket: { idTiket, idPelanggan, kendala, status: "Menunggu Teknisi" }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 7. REAL SPEEDTEST API ENDPOINTS
// ==========================================

// A. Real Ping Endpoint
app.get('/api/speedtest/ping', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.json({ success: true, timestamp: Date.now() });
});

// B. Real Download Test (Stream Binary Buffer)
const randomChunk1MB = crypto.randomBytes(1024 * 1024); // 1MB buffer template
app.get('/api/speedtest/download', (req, res) => {
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const requestedMB = Math.min(Math.max(parseInt(req.query.size || '10', 10), 1), 30); // 1MB to 30MB
  res.setHeader('Content-Length', String(requestedMB * 1024 * 1024));

  for (let i = 0; i < requestedMB; i++) {
    res.write(randomChunk1MB);
  }
  res.end();
});

// C. Real Upload Test (Receive Binary Payload)
app.post('/api/speedtest/upload', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache');
  const size = req.body ? req.body.length : (parseInt(req.headers['content-length'] || '0', 10));
  res.json({ success: true, bytesReceived: size, timestamp: Date.now() });
});

// Fallback JSON jika endpoint tidak ada
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Endpoint ${req.originalUrl} tidak ditemukan` });
});

if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server aktif di http://localhost:${PORT}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ Port ${PORT} sudah dipakai! Silakan matikan proses node lain dulu.`);
    } else {
      console.error(`❌ Server Error:`, err.message);
    }
  });
}

module.exports = app;