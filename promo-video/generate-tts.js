import fs from 'fs';
import path from 'path';
import { Communicate } from 'edge-tts-universal';

// Custom Voice: Yunjie is a highly mature, confident, and professional Mandarin male voice
// Note: In edge-tts-universal, the ShortName (zh-CN-YunjieNeural) is parsed and formatted during construct.
const VOICE_NAME = 'zh-CN-YunxiNeural';

const NARRATION_SCENES = [
  {
    id: 'scene1',
    text: '你把关键任务交给了 AI 智能体。但它不记得你昨天的教训，今天又犯了同样的错。',
    options: {
      voice: VOICE_NAME
    }
  },
  {
    id: 'scene2',
    text: 'AI 智能体是无状态的执行工具。每次会话结束，你所有的纠正、教训和要求，都随上下文一起消失了。',
    options: {
      voice: VOICE_NAME
    }
  },
  {
    id: 'scene3',
    text: 'Principles Disciple 捕获你的纠正与 AI 的行为偏差，将零散的教训，沉淀为 AI 智能体持久的行为品格。可审查，可回滚。',
    options: {
      voice: VOICE_NAME
    }
  },
  {
    id: 'scene4',
    text: '让 AI 从工具变成有品格的伙伴。Principles Disciple —— 燃烧痛苦，协同进化。',
    options: {
      voice: VOICE_NAME
    }
  }
];

async function generateTTS() {
  // Create assets directory if it doesn't exist
  const assetsDir = path.resolve('assets');
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
    console.log(`Created assets directory at: ${assetsDir}`);
  }

  console.log(`Starting Edge TTS synthesis via Communicate stream...`);
  console.log(`Voice model: ${VOICE_NAME}`);

  for (const scene of NARRATION_SCENES) {
    const outputPath = path.join(assetsDir, `${scene.id}.mp3`);
    console.log(`\n[${scene.id}] Synthesizing text: "${scene.text}"`);
    console.log(`Prosody options: ${JSON.stringify(scene.options)}`);

    try {
      const communicate = new Communicate(scene.text, scene.options);
      const writeStream = fs.createWriteStream(outputPath);

      let receivedAudio = false;

      for await (const chunk of communicate.stream()) {
        if (chunk.type === 'audio' && chunk.data) {
          writeStream.write(chunk.data);
          receivedAudio = true;
        }
      }

      await new Promise((resolve) => {
        writeStream.end(resolve);
      });

      if (!receivedAudio || fs.statSync(outputPath).size === 0) {
        throw new Error('Synthesized file is empty or no audio data was received.');
      }

      console.log(`[OK] Successfully saved synthesized audio to: ${outputPath} (${fs.statSync(outputPath).size} bytes)`);
    } catch (err) {
      console.error(`[ERR] Synthesis failed for ${scene.id}:`, err.message || err);
      process.exit(1);
    }
  }

  console.log('\n[SUCCESS] All narration scenes synthesized and saved to assets/ directory using Microsoft Edge TTS stream.');
}

generateTTS();
