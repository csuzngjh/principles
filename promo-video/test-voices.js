import { listVoices } from 'edge-tts-universal';

async function test() {
  try {
    const voices = await listVoices();
    console.log('Voices count:', voices.length);
    const enVoices = voices.filter(v => v.Locale.startsWith('en'));
    console.log('EN Voices:', enVoices.map(v => `${v.ShortName} (${v.Gender})`));
  } catch (err) {
    console.error('Error:', err);
  }
}

test();
