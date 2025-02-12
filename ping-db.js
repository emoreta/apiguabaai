const { createPool } = require('mysql2/promise');
const { Sequelize, DataTypes } = require('sequelize');
require('dotenv').config();

// Crear el pool de conexiones
const pool = createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Configuración de Sequelize reutilizando el pool
const sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASS, {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT|| 3306,
  dialect: 'mysql',
  logging: false,
  pool: {
    max: 10,
    min: 0,
    acquire: 30000,
    idle: 10000
  },
  dialectModule: require('mysql2') // Usa mysql2 para Sequelize
});

// Verificar conexión
(async () => {
  try {
    const connection = await pool.getConnection();
    console.log('¡Conexión con el pool exitosa!');
    connection.release();

    await sequelize.authenticate();
    console.log('Sequelize también se conectó con éxito.');
  } catch (error) {
    console.error('Error al conectar:', error);
  }
})();
