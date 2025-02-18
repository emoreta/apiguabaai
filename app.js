const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const { sequelize, Document } = require('./db');
const axios = require('axios');
const cors = require('cors');
const port = 3000;
require('dotenv').config();
console.log(process.env.TOGETHER)
// Variables de configuración
const USERNAME = process.env.AUTH_USERNAME || '';
const PASSWORD = process.env.AUTH_PASSWORD || '';
const TOGETHER_API_KEY = process.env.TOGETHER || '';

// Configura CORS para permitir el origen localhost:3000
/*app.use(cors({
  origin: 'http://localhost:3000',  // Permite solo este origen
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));*/
app.use(cors());

app.use(bodyParser.json({ limit: '10mb' }));
const model = process.env.MODEL_VISION1;

// Middleware de autenticación básica
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic');
    return res.status(401).json({ error: 'Autenticación requerida.' });
  }

  const base64Credentials = authHeader.split(' ')[1];
  const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
  const [username, password] = credentials.split(':');

  if (username === USERNAME && password === PASSWORD) {
    next();
  } else {
    return res.status(403).json({ error: 'Credenciales incorrectas.' });
  }
};
const systemPrompt = `Convert the provided image into Markdown format. Ensure that all content from the page is included, such as headers, footers, subtexts, images (with alt text if possible), tables, and any other elements.

  Requirements:

  - Output Only Markdown: Return solely the Markdown content without any additional explanations or comments.
  - No Delimiters: Do not use code fences or delimiters like \`\`\`markdown.
  - Complete Content: Do not omit any part of the page, including headers, footers, and subtext.
  `;

// Función para convertir una imagen desde una URL a Base64
const encodeImage = async (imageUrl) => {
  try {
    const response = await fetch(imageUrl);
    const arrayBuffer = await response.arrayBuffer();
    const base64Image = Buffer.from(arrayBuffer).toString('base64');
    return base64Image;
  } catch (error) {
    throw new Error(`Error al convertir la imagen a base64: ${error.message}`);
  }
};

// Función para extraer información de la imagen usando Together-AI
const extractInfoFromImageT = async (image64) => {
  try {
    const response = await fetch('https://api.together.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOGETHER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: systemPrompt },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${image64}`
                }
              }
            ]
          }
        ],
        stream: false
      })
    });

    const jsonData = await response.json();
    const extractedText = jsonData.choices[0]?.message?.content || '';
    return extractedText;
  } catch (error) {
    console.error('Error al extraer información de la imagen:', error.message);
    throw error;
  }
};

// Endpoint para procesar la imagen
app.post('/callApiChatTogether', authenticate, async (req, res) => {
  console.log('callApiChatTogether');
  const { context, query } = req.body;
  console.log('callApiChatTogether', context, query);
  try {
    const response = await fetch('https://api.together.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOGETHER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: "user",
            content: "Adjunto contexto:\n " + context + " \n\nResponde la siguiente pregunta basándote únicamente en el contexto proporcionado: " + query
          }],
        stream: false
      })
    });
    const jsonData = await response.json();
    const extractedText = jsonData.choices[0]?.message?.content || '';
    //return extractedText;
    res.status(200).json({ "Answer": extractedText });
  } catch (error) {
    console.error('Error al responder:', error.message);
    //throw error;
    res.status(500).json({ error: 'Error al procesar .', details: error.message });
  }
});

// Endpoint para procesar la imagen
app.post('/callApiChatTogetherRag', authenticate, async (req, res) => {
  const { context, query } = req.body;
  console.log('callApiChatTogetherRag', query);
  try {
    const response = await fetch('https://api.together.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOGETHER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: "user",
            content: query
          }],
        stream: false
      })
    });

    const jsonData = await response.json();

    const extractedText = jsonData.choices[0]?.message?.content || '';
    console.log(extractedText)
    res.status(200).json({ "Answer": extractedText });
  } catch (error) {
    console.error('Error al responder:', error.message);
    //throw error;
    res.status(500).json({ error: 'Error al procesar .', details: error.message });
  }
});

// Endpoint para procesar la imagen
app.post('/extract-info', authenticate, async (req, res) => {
  const { imageUrl } = req.body;

  if (!imageUrl) {
    return res.status(400).json({ error: 'Por favor proporciona la URL de la imagen.' });
  }

  try {
    const base64Image = await encodeImage(imageUrl);
    const result = await extractInfoFromImageT(base64Image);
    res.status(200).json({ extractedText: result });
  } catch (error) {
    res.status(500).json({ error: 'Error al procesar la imagen.', details: error.message });
  }
});
//nuevo api para insertar a base de datos
app.post('/add-document', authenticate, async (req, res) => {
  const {
    name,
    extension,
    document_id,
    author,
    pages,
    description,
    name_json,
    upload_date,
    created_date,
    isActive,
    userId, url_json, json_text, TypeDocumentId
  } = req.body;

  try {
    const newDocument = await Document.create({
      name,
      extension,
      document_id,
      author,
      pages,
      description,
      name_json,
      upload_date,
      created_date,
      isActive: isActive ? 1 : 0,
      userId, url_json
    });

    // Ahora, llamamos a la API externa para guardar el JSON
    const response = await axios.post('https://upload.guabastudio.site/save-json', {
      jsonString: json_text,  // Aquí pasamos el json_text como parte del cuerpo
      fileName: name_json,    // Usamos el nombre del archivo JSON
      pathFile: 'json_files'  // El directorio de destino, por ejemplo
    });

    // Si la respuesta de la API externa es exitosa, respondemos con éxito
    if (response.status === 200) {
      res.status(201).json({
        message: 'Documento insertado con éxito y JSON guardado',
        document: newDocument,
        externalApiResponse: response.data  // Aquí puedes incluir los datos que devuelve la API externa
      });
    } else {
      res.status(500).json({
        error: 'Error al guardar el JSON en la API externa',
        details: response.data
      });
    }
  } catch (error) {
    console.error('Error al insertar el documento:', error);
    res.status(500).json({ error: 'Error al insertar el documento.', details: error.message });
  }
});
// Obtener todos los documentos
app.get('/documents', authenticate, async (req, res) => {
  try {
    const documents = await Document.findAll();
    res.json(documents);
  } catch (error) {
    console.error("Error al obtener documentos:", error);
    res.status(500).json({ error: "Error al obtener documentos" });
  }
});

// Obtener documento por ID
app.get('/documents/:id', authenticate, async (req, res) => {
  const { id } = req.params;
  try {
    const document = await Document.findByPk(id);
    if (!document) {
      return res.status(404).json({ error: "Documento no encontrado" });
    }
    res.json(document);
  } catch (error) {
    console.error("Error al obtener documento:", error);
    res.status(500).json({ error: "Error al obtener documento" });
  }
});
// Endpoint para actualizar un documento por ID
app.put('/documents/:id', authenticate, async (req, res) => {
  const { id } = req.params;
  const {
    name,
    extension,
    document_id,
    author,
    pages,
    description,
    name_json,
    upload_date,
    created_date,
    isActive,
    userId,
    url_json,
    TypeDocumentId
  } = req.body;

  try {
    // Buscar el documento en la base de datos
    const document = await Document.findByPk(id);
    if (!document) {
      return res.status(404).json({ error: "Documento no encontrado" });
    }

    // Actualizar el documento con los nuevos valores
    await document.update({
      name,
      extension,
      document_id,
      author,
      pages,
      description,
      name_json,
      upload_date,
      created_date,
      isActive: isActive ? 1 : 0,
      userId,
      url_json,
      TypeDocumentId
    });

    res.json({ message: "Documento actualizado correctamente", document });
  } catch (error) {
    console.error("Error al actualizar documento:", error);
    res.status(500).json({ error: "Error al actualizar documento" });
  }
});

//----------------------------------------------------------

app.listen(port, () => {
  console.log(`Servidor escuchando en http://localhost:${port}`);
});
