const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;

const BIDPATH_API     = 'https://bid.birdsnestauctions.com/api/graphql';
const INTEGRATION_KEY = process.env.INTEGRATION_KEY || 'b619606be303fbcbcb5a2e394c9ba6a0d3ee8f39d2fe1375900f130933367605';

app.use(cors());
app.use(express.json());

app.post('/graphql', async (req, res) => {
  try {
    const headers = {
      'Content-Type': 'application/json',
      'X-Integration-Key': INTEGRATION_KEY,
    };
    if (req.headers.authorization) {
      headers['Authorization'] = req.headers.authorization;
    }

    const response = await fetch(BIDPATH_API, {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).json({ errors: [{ message: err.message }] });
  }
});

app.get('/', (req, res) => res.send('BNA proxy running.'));

app.listen(PORT, () => console.log(`Proxy listening on port ${PORT}`));
