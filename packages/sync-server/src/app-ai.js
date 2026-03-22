import express from 'express';

import { secretsService } from './services/secrets-service';
import {
  requestLoggerMiddleware,
  validateSessionMiddleware,
} from './util/middlewares';

const app = express();
export { app as handlers };

app.use(express.json({ limit: '1mb' }));
app.use(requestLoggerMiddleware);
app.use(validateSessionMiddleware);

// Proxy POST /ai/anthropic → https://api.anthropic.com/v1/messages
// This avoids CORS issues when calling Anthropic directly from the browser.
app.post('/anthropic', async (req, res) => {
  const envValue = process.env.ANTHROPIC_API_KEY;
  const dbValue = secretsService.get('anthropic_api_key');
  const apiKey = dbValue || envValue;

  if (!apiKey) {
    return res.status(404).json({ error: 'anthropic_api_key not configured' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Anthropic proxy error:', err);
    res.status(500).json({ error: 'proxy-error', message: String(err) });
  }
});
