const mysql = require('mysql');

const connection = mysql.createConnection({
  host: process.env.MYSQLHOST, // Cambia por tu IP o dominio
  port: process.env.MYSQLPORT || 3306,
  user: process.env.MYSQLUSER,  // Usuario de MySQL
  password: process.env.MYSQLPASSWORD// Contraseña de MySQL
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