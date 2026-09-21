let nodemailer;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  // nodemailer will be available in production
}
const fs = require('fs');
const path = require('path');
const supabase = require('./db');

const SETTINGS_FILE = path.join(__dirname, 'settings.json');

async function getEmailSettings() {
  // 1. Cek Supabase SYSTEM_SETTINGS (Persisten di Cloud / Vercel)
  try {
    const { data } = await supabase
      .from('customers')
      .select('visit_checklist')
      .eq('customer_code', 'SYSTEM_SETTINGS')
      .single();
    if (data && data.visit_checklist && data.visit_checklist.smtp) {
      const s = data.visit_checklist.smtp;
      if (s.user && s.pass) return s;
    }
  } catch (e) {}

  // 2. Cek settings.json lokal
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (data.smtp && data.smtp.user && data.smtp.pass) return data.smtp;
    } catch (e) {}
  }

  // 3. Cek Environment Variables Vercel
  return {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '465', 10),
    secure: (process.env.SMTP_SECURE === 'true' || process.env.SMTP_PORT === '465' || !process.env.SMTP_PORT),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'WBnetwork Billing <no-reply@wbnetwork.id>'
  };
}

async function sendOtpEmail(toEmail, otpCode, customerName = 'Pelanggan', type = 'login') {
  const smtp = await getEmailSettings();

  const title = type === 'register' ? 'Verifikasi Pendaftaran Email Pelanggan' : 'Kode OTP Masuk Portal Pelanggan';
  const desc = type === 'register' 
    ? `Terima kasih telah mendaftarkan email Anda untuk akun <b>${customerName}</b> di WBnetwork RT/RW Net. Gunakan kode OTP berikut untuk menyelesaikan verifikasi email Anda:`
    : `Halo <b>${customerName}</b>, kami menerima permintaan masuk ke portal pelanggan WBnetwork. Gunakan kode keamanan OTP 6 digit berikut:`;

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f1f5f9; margin: 0; padding: 20px; color: #1e293b; }
        .card { max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 16px; padding: 32px 24px; box-shadow: 0 10px 25px rgba(0,0,0,0.06); border: 1px solid #e2e8f0; }
        .header { text-align: center; margin-bottom: 24px; }
        .logo { font-size: 24px; font-weight: 800; color: #2563eb; letter-spacing: -0.5px; }
        .badge { display: inline-block; background: #eff6ff; color: #1d4ed8; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 700; margin-top: 6px; }
        .otp-box { background: #f8fafc; border: 2px dashed #cbd5e1; border-radius: 12px; text-align: center; padding: 20px; margin: 24px 0; }
        .otp-code { font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #0f172a; margin: 0; font-family: 'Courier New', Courier, monospace; }
        .expiry { color: #dc2626; font-size: 13px; font-weight: 600; margin-top: 8px; }
        .footer { text-align: center; font-size: 12px; color: #64748b; margin-top: 24px; border-top: 1px solid #f1f5f9; padding-top: 16px; }
        .warning { background: #fffbeb; border-left: 4px solid #f59e0b; padding: 12px; border-radius: 6px; font-size: 12px; color: #b45309; line-height: 1.5; margin-top: 16px; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          <div class="logo">⚡ WBnetwork</div>
          <span class="badge">${title}</span>
        </div>
        <p style="font-size: 14px; line-height: 1.6; color: #334155; margin-bottom: 0;">
          ${desc}
        </p>
        
        <div class="otp-box">
          <div style="font-size: 12px; text-transform: uppercase; color: #64748b; font-weight: 700; margin-bottom: 6px;">KODE KEAMANAN OTP ANDA</div>
          <div class="otp-code">${otpCode}</div>
          <div class="expiry">⏱️ Berlaku selama 10 menit</div>
        </div>

        <div class="warning">
          ⚠️ <b>Penting:</b> Jangan berikan kode OTP ini kepada siapapun termasuk petugas yang mengaku dari WBnetwork.
        </div>

        <div class="footer">
          Jika Anda tidak merasa melakukan permintaan ini, silakan abaikan email ini.<br>
          © ${new Date().getFullYear()} WBnetwork RT/RW Net Management System.
        </div>
      </div>
    </body>
    </html>
  `;

  // Cek apakah SMTP sudah diisi
  if (!smtp.user || !smtp.pass) {
    console.log(`\n======================================================`);
    console.log(`[SIMULASI EMAIL OTP WBnetwork]`);
    console.log(`Tujuan: ${toEmail} | Pelanggan: ${customerName}`);
    console.log(`Kode OTP: >>> [ ${otpCode} ] <<<`);
    console.log(`Catatan: Akun SMTP belum diisi di Admin Setting. OTP dicatat di layar.`);
    console.log(`======================================================\n`);
    return {
      success: true,
      simulated: true,
      otp: otpCode,
      message: `Kode OTP (Simulasi): ${otpCode}. (Isi SMTP Gmail di Admin Setting agar terkirim ke email sungguhan).`
    };
  }

  if (!nodemailer) {
    nodemailer = require('nodemailer');
  }

  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host || 'smtp.gmail.com',
      port: parseInt(smtp.port || '465', 10),
      secure: (smtp.port === 465 || smtp.port === '465' || smtp.secure === true),
      auth: {
        user: smtp.user.trim(),
        pass: smtp.pass.replace(/\s+/g, '') // Hapus spasi jika user copy-paste app password google dengan spasi
      },
      tls: {
        rejectUnauthorized: false
      }
    });

    const info = await transporter.sendMail({
      from: smtp.from || `"WBnetwork" <${smtp.user}>`,
      to: toEmail,
      subject: `[${otpCode}] ${title} - WBnetwork`,
      html: htmlContent
    });

    console.log(`✅ [EMAIL OTP TERKIRIM]: Ke ${toEmail}, MsgId: ${info.messageId}`);

    return {
      success: true,
      simulated: false,
      messageId: info.messageId,
      message: `Kode OTP berhasil dikirim ke ${toEmail}. Silakan cek kotak masuk/spam email Anda.`
    };
  } catch (err) {
    console.error("❌ [MAILER ERROR]:", err.message);
    throw new Error(`Gagal mengirim email: ${err.message}. Pastikan akun Gmail dan Sandi Aplikasi 16 digit sudah benar.`);
  }
}

module.exports = {
  getEmailSettings,
  sendOtpEmail
};
