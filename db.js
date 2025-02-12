const { Sequelize, DataTypes } = require('sequelize');
require('dotenv').config();

// Configuración de la conexión
const sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASS, {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  dialect: 'mysql',
  logging: false, // Desactiva el logging de SQL en la consola
  dialectOptions: {
    connectTimeout: 120000,  // Timeout de 60 segundos
  },
  pool: {
    max: 5,
    min: 0,
    acquire: 120000,  // Tiempo máximo para intentar conectar
    idle: 10000
  }
});

// Verificar conexión
(async () => {
  try {
    await sequelize.authenticate();
    console.log(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASS,process.env.DB_HOST,process.env.DB_PORT);
    console.log('Conexión establecida con éxito.');
  } catch (error) {
    console.log(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASS,process.env.DB_HOST,process.env.DB_PORT);
    console.error('Error al conectar con la base de datos:', error);
  }
})();

// Definición del modelo
const Document = sequelize.define('Document', {
  id: {
    type: DataTypes.BIGINT,
    autoIncrement: true,
    primaryKey: true
  },
  name: {
    type: DataTypes.STRING(900),
    allowNull: true
  },
  extension: {
    type: DataTypes.STRING(900),
    allowNull: true
  },
  document_id: {
    type: DataTypes.STRING(900),
    allowNull: true
  },
  author: {
    type: DataTypes.STRING(500),
    allowNull: true
  },
  pages: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  description: {
    type: DataTypes.STRING(1000),
    allowNull: true
  },
  name_json: {
    type: DataTypes.STRING(1000),
    allowNull: true
  },
  url_json: {
    type: DataTypes.STRING(8000),
    allowNull: true
  },
  upload_date: {
    type: DataTypes.DATE,
    allowNull: true
  },
  created_date: {
    type: DataTypes.DATE,
    allowNull: true
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    allowNull: true
  },
  userId: {
    type: DataTypes.BIGINT,
    allowNull: true
  }
}, {
  tableName: 'document',
  timestamps: false
});

module.exports = { sequelize, Document };
