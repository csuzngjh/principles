import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

const VOICE_NAME = 'en-US-BrianNeural';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

const NARRATION_SCENES = [
  {
    id: 'scene1_en',
    text: "You delegated a critical task to your AI agent. But it forgot yesterday's lesson, making the exact same mistake again today.",
    rate: '-4%',
    pitch: '-2Hz'
  },
  {
    id: 'scene2_en',
    text: "AI agents are stateless execution tools. Once the session ends, all your corrections, lessons, and instructions vanish with the context.",
    rate: '-2%',
    pitch: '-1Hz'
  },
  {
    id: 'scene3_en',
    text: "Principles Disciple captures your corrections and AI behavioral drift, crystallizing fragmented lessons into durable character for your AI agents. Auditable and reversible.",
    rate: '+2%',
    pitch: '+1Hz'
  },
  {
    id: 'scene4_en',
    text: "Transform AI from a mere tool into a partner with character. Principles Disciple — Burn pain, co-evolve.",
    rate: '-5%',
    pitch: '-1Hz'
  }
];

// Anti-abuse dynamic GEC token generator
function generateSecMsGec() {
  const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
  const WIN_EPOCH = 11644473600;
  const S_TO_NS = 1e9;
  
  let ticks = Date.now() / 1000;
  ticks += WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= S_TO_NS / 100;
  
  const strToHash = `${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`;
  return createHash('sha256').update(strToHash, 'ascii').digest('hex').toUpperCase();
}

function escapeXml(unsafe) {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

function synthesizeScene(scene, assetsDir) {
  return new Promise((resolve, reject) => {
    const outputPath = path.join(assetsDir, `${scene.id}.mp3`);
    console.log(`\n[${scene.id}] Synthesizing: "${scene.text}"`);

    const connectionId = uuidv4().replace(/-/g, '');
    const gec = generateSecMsGec();
    
    const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=1-143.0.3650.75&ConnectionId=${connectionId}`;

    const ws = new WebSocket(wsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    const audioChunks = [];
    let writeStream = fs.createWriteStream(outputPath);

    ws.on('open', () => {
      // 1. Send config
      const dateStr = new Date().toUTCString();
      const configMessage = `X-Timestamp:${dateStr}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${OUTPUT_FORMAT}"}}}}\r\n`;
      ws.send(configMessage);

      // 2. Send SSML
      const ssmlText = escapeXml(scene.text);
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${VOICE_NAME}'><prosody rate='${scene.rate || '+0%'}' pitch='${scene.pitch || '+0Hz'}'>${ssmlText}</prosody></voice></speak>`;
      const ssmlMessage = `X-RequestId:${connectionId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${dateStr}\r\nPath:ssml\r\n\r\n${ssml}`;
      ws.send(ssmlMessage);
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const headerLength = data.readUInt16BE(0);
        const headers = data.subarray(2, headerLength + 2).toString('utf-8');
        if (headers.includes('Path:audio')) {
          const audioData = data.subarray(headerLength + 2);
          if (audioData.length > 0) {
            writeStream.write(audioData);
            audioChunks.push(audioData);
          }
        }
      } else {
        const textMessage = data.toString('utf-8');
        if (textMessage.includes('Path:turn.end')) {
          ws.close();
        }
      }
    });

    ws.on('error', (err) => {
      console.error(`[ERR] WebSocket error for ${scene.id}:`, err);
      writeStream.end();
      reject(err);
    });

    ws.on('close', (code, reason) => {
      writeStream.end();
      if (audioChunks.length === 0 || fs.statSync(outputPath).size === 0) {
        reject(new Error(`Synthesized file is empty. WS closed with code: ${code}, reason: "${reason.toString('utf-8')}"`));
      } else {
        console.log(`[OK] Successfully saved synthesized audio to: ${outputPath} (${fs.statSync(outputPath).size} bytes)`);
        resolve();
      }
    });
  });
}

async function generateTTS() {
  const assetsDir = path.resolve('assets');
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }

  console.log(`Starting custom WebSocket Microsoft Edge English TTS synthesis...`);
  console.log(`Voice model: ${VOICE_NAME}`);

  for (const scene of NARRATION_SCENES) {
    try {
      await synthesizeScene(scene, assetsDir);
    } catch (err) {
      console.error(`[ERR] English synthesis failed:`, err.message || err);
      process.exit(1);
    }
  }

  console.log('\n[SUCCESS] All English narration scenes synthesized and saved to assets/ directory.');
}

generateTTS();
