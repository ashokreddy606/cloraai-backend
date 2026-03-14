const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('OK'));
app.listen(3000, '0.0.0.0', () => console.log('Test server on 3000'));
