const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const supabase = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const PAYMENT_METHODS_FILE = path.join(__dirname, 'payment_methods.json');

// Helper Get & Save Settings
function getSettings() {
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch (e) {}
  }
  return {
    adminWhatsapp: '081234567890',
    merchantName: 'WBnetwork RT/RW Net',
    paymentMethods: []
  };
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.use(express.static(__dirname, { index: false }));

// Helper Pemformat Data
function formatResponse(customer, listTagihan, listTiket) {
  const tagihan = listTagihan && listTagihan.length > 0 ? listTagihan[0] : null;
  const tiketAktif = listTiket && listTiket.length > 0 ? listTiket[0] : null;

  const pkg = customer.package_name || customer.paket || '20 Mbps Home Fiber';
  const price = (tagihan && tagihan.nominal) || customer.monthly_price || 200000;
  const due = (tagihan && (tagihan.jatuh_tempo || tagihan.jatuhTempo)) || customer.due_day || '10';

  return {
    success: true,
    data: {
      id: customer.customer_code,
      customer_code: customer.customer_code,
      name: customer.name,
      status: customer.customer_status || customer.status || 'aktif',
      connection_status: customer.connection_status || customer.status_koneksi || 'online',
      package: pkg,
      package_name: pkg,
      address: customer.address || customer.alamat || 'Alamat tidak diisi',
      monthly_price: price,
      due_day: due,
      visit_checklist: customer.visit_checklist || {},
      
      tagihan: tagihan ? {
        bulan: tagihan.bulan,
        nominal: tagihan.nominal,
        status: tagihan.status,
        jatuhTempo: tagihan.jatuh_tempo || tagihan.jatuhTempo,
      } : {
        bulan: 'Bulan Ini',
        nominal: price,
        status: (customer.visit_checklist && customer.visit_checklist.payment_status) || 'Belum Lunas',
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

// 2. Handler API Data Pelanggan
app.get(['/api/pelanggan/:id', '/pelanggan/data/:id', '/api/customer/:id', '/pelanggan/:id'], async (req, res) => {
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

// 3. API Settings (Nomor WhatsApp Admin & Metode Pembayaran)
app.get('/api/settings', (req, res) => {
  const settings = getSettings();
  res.json({ success: true, data: settings });
});

app.post('/api/settings', (req, res) => {
  try {
    const current = getSettings();
    const updated = { ...current, ...req.body };
    saveSettings(updated);
    res.json({ success: true, message: "Pengaturan berhasil disimpan!", data: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Legacy Payment Methods compatibility
app.get('/api/payment-methods', (req, res) => {
  const settings = getSettings();
  res.json({ success: true, data: settings.paymentMethods || [] });
});

app.post('/api/payment-methods', (req, res) => {
  try {
    const settings = getSettings();
    settings.paymentMethods = req.body;
    saveSettings(settings);
    res.json({ success: true, message: "Metode pembayaran berhasil disimpan!", data: req.body });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. API Konfirmasi Pembayaran oleh Pelanggan
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

// 5. 1-Klik Setujui Lunas via WhatsApp Link untuk Admin
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

// 6. API Lapor Gangguan
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

// Fallback JSON jika endpoint tidak ada
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Endpoint ${req.originalUrl} tidak ditemukan` });
});

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