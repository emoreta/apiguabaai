const mysql = require('mysql2/promise');

(async () => {
  const config = {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
  };

  console.log('Intentando conectar a la base de datos...');

  try {
    const connection = await mysql.createConnection(config);
    console.log('¡Conexión exitosa!');
    
    const [result] = await connection.query('SELECT 1 + 1 AS result');
    console.log('Resultado de la consulta:', result);

    await connection.end();
    console.log('Conexión cerrada.');
  } catch (error) {
    console.error('Error al conectar:', error.message);
  }
})();