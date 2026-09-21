const supabase = require('./db');
async function test() {
  console.log('');
  console.log('========================================');
  console.log('       WBnetwork - Supabase Test');
  console.log('========================================');
  console.log('Menghubungkan ke database...');

  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .limit(100);

  if (error) {
    console.log('');
    console.log('❌ GAGAL MEMBACA DATABASE');
    console.log(error.message);
    return;
  }

  console.log('✅ BERHASIL TERHUBUNG KE SUPABASE');
  console.log(`📊 Jumlah data terbaca: ${data.length}`);
  console.log('----------------------------------------');

  data.slice(0, 5).forEach((customer, index) => {
    console.log(`${index + 1}.`, customer);
  });

  console.log('----------------------------------------');
  console.log('Tes selesai.');
  console.log('');
}

test();