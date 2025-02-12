const mysql = require('mysql');

const connection = mysql.createConnection({
  host: 'guabastudio.com', // Cambia por tu IP o dominio
  port: 3306,
  user: 'guabastu_app',  // Usuario de MySQL
  password: 'Procredit2017g' // Contraseña de MySQL
});

connection.connect((err) => {
  if (err) {
    console.log(`❌ No se pudo conectar a ${connection.config.host}:${connection.config.port}`);
    console.error('Error:', err.message);
  } else {
    console.log(`✅ Conexión exitosa a ${connection.config.host}:${connection.config.port}`);
  }
  connection.end();
});