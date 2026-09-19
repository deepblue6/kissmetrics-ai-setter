/**
 * Claude API wrapper via OpenRouter — retry + model fallback
 */

import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";

const RETRY_CONFIG = [
  { model: "anthropic/claude-opus-4-5", delay: 0 },
  { model: "anthropic/claude-sonnet-4-6", delay: 2000 },
  { model: "anthropic/claude-sonnet-4-6", delay: 5000 },
];

function createProxyAgent() {
  const proxy = process.env.OUTBOUND_PROXY;
  const auth = process.env.OUTBOUND_PROXY_AUTH;
  if (!proxy || !auth) return null;
  return new HttpsProxyAgent(`http://${auth}@${proxy}`);
}

/**
 * Call Claude via OpenRouter API (OpenAI-compatible format)
 * @param {Array} messages - Array of {role, content} messages
 * @param {Object} options - { system, maxTokens, temperature }
 * @returns {string|null} - Reply text or null on failure
 */
export async function callClaude(messages, options = {}) {
  const { system, maxTokens = 300, temperature = 0.45 } = options;

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("[Claude] OPENROUTER_API_KEY is not set");
    return null;
  }

  // Prepend system message to the messages array (OpenAI format)
  const fullMessages = [];
  if (system) {
    fullMessages.push({ role: "system", content: system });
  }
  fullMessages.push(...messages);

  for (let attempt = 0; attempt < RETRY_CONFIG.length; attempt++) {
    const { model, delay } = RETRY_CONFIG[attempt];

    if (delay > 0) {
      console.log(`[Claude] Waiting ${delay / 1000}s before retry (attempt ${attempt + 1})...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    try {
      const axiosConfig = {
        method: "POST",
        url: "https://openrouter.ai/api/v1/chat/completions",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        data: {
          model,
          messages: fullMessages,
          temperature,
          max_tokens: maxTokens,
        },
        timeout: 30000,
        validateStatus: () => true,
      };

      const agent = createProxyAgent();
      if (agent) {
        axiosConfig.httpsAgent = agent;
        axiosConfig.httpAgent = agent;
      }

      const response = await axios(axiosConfig);

      if (response.status < 200 || response.status >= 300) {
        const errorText = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
        console.error(`[Claude] API error (attempt ${attempt + 1}, ${model}): ${response.status} ${errorText}`);

        if (response.status === 401) {
          console.error(`[Claude] Your OPENROUTER_API_KEY is invalid or expired. Check it at https://openrouter.ai/keys`);
        } else if (response.status === 402) {
          console.error(`[Claude] OpenRouter account has insufficient credits. Top up at https://openrouter.ai/credits`);
        } else if (response.status === 429) {
          console.error(`[Claude] Rate limited. The agent will retry automatically.`);
        }

        if (attempt === RETRY_CONFIG.length - 1) return null;
        continue;
      }

      const text = response.data?.choices?.[0]?.message?.content?.trim();
      if (!text) {
        console.error(`[Claude] Empty response (attempt ${attempt + 1})`);
        if (attempt === RETRY_CONFIG.length - 1) return null;
        continue;
      }

      if (attempt > 0) console.log(`[Claude] Success on attempt ${attempt + 1} with ${model}`);
      return text;
    } catch (error) {
      console.error(`[Claude] Request failed (attempt ${attempt + 1}, ${model}): ${error.message}`);
      if (attempt === RETRY_CONFIG.length - 1) return null;
    }
  }

  return null;
}

export default callClaude;
