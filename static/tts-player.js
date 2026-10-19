/**
 * TTS Player - Standalone word-highlighting audio player
 * Drop this on any page with exported TTS data
 */
class TTSPlayer {
  static init(options) {
    const container = typeof options.container === 'string' 
      ? document.querySelector(options.container) 
      : options.container;
    
    if (!container) throw new Error('Container not found');
    
    // Clear container
    container.innerHTML = '';
    
    // Create player UI
    const player = document.createElement('div');
    player.className = 'tts-player';
    player.innerHTML = `
      <style>
        .tts-player {
          font-family: system-ui, -apple-system, sans-serif;
          max-width: 800px;
          margin: 0 auto;
        }
        .tts-audio {
          width: 100%;
          margin: 10px 0;
        }
        .tts-highlight {
          padding: 16px;
          border: 1px solid var(--border, #e2e2e2);
          border-radius: 8px;
          background: var(--bg2, #f7f7f8);
          color: var(--fg, inherit);
          line-height: 1.8;
          font-size: 16px;
          min-height: 60px;
          max-height: 300px;
          overflow-y: auto;
        }
        .tts-word {
          display: inline;
          padding: 1px 2px;
          border-radius: 3px;
          transition: background .08s;
        }
        .tts-word.active {
          background: var(--highlight, #fef08a);
          font-weight: 600;
        }
        .tts-meta {
          font-size: 12px;
          color: var(--fg2, #666);
          margin-top: 4px;
        }
      </style>
      <audio class="tts-audio" controls></audio>
      <div class="tts-highlight"></div>
      <div class="tts-meta"></div>
    `;
    
    container.appendChild(player);
    
    const audio = player.querySelector('.tts-audio');
    const highlight = player.querySelector('.tts-highlight');
    const meta = player.querySelector('.tts-meta');
    
    // Load data
    if (options.data) {
      TTSPlayer.loadFromData(options.data, audio, highlight, meta);
    } else if (options.url) {
      TTSPlayer.loadFromUrl(options.url, audio, highlight, meta);
    } else {
      throw new Error('Provide either data or url');
    }
  }
  
  static loadFromData(data, audio, highlight, meta) {
    // Set up audio
    const audioBlob = TTSPlayer.base64ToBlob(data.audio, data.contentType);
    audio.src = URL.createObjectURL(audioBlob);
    
    // Render text with word spans
    const words = data.boundaries.map(b => b.text);
    highlight.innerHTML = words.map((word, i) => 
      `<span class="tts-word">${word}</span>${i < words.length - 1 ? ' ' : ''}`
    ).join('');
    
    const wordSpans = highlight.querySelectorAll('.tts-word');
    
    // Highlighting logic
    let userScrolled = false;
    let scrollTimer = null;
    
    highlight.addEventListener('scroll', () => {
      if (highlight._autoScrolling) return;
      userScrolled = true;
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => { userScrolled = false; }, 3000);
    }, { passive: true });
    
    function updateHighlight() {
      const t = audio.currentTime * 10000000; // Convert to 100ns units
      let activeIdx = -1;
      
      for (let i = 0; i < data.boundaries.length; i++) {
        const b = data.boundaries[i];
        if (t >= b.offset && t < b.offset + b.duration) {
          activeIdx = i;
          break;
        }
        if (t >= b.offset) activeIdx = i;
      }
      
      wordSpans.forEach((s, i) => s.classList.toggle('active', i === activeIdx));
      
      if (activeIdx >= 0 && wordSpans[activeIdx] && !userScrolled) {
        highlight._autoScrolling = true;
        wordSpans[activeIdx].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        setTimeout(() => { highlight._autoScrolling = false; }, 100);
      }
    }
    
    audio.addEventListener('timeupdate', updateHighlight);
    audio.addEventListener('ended', () => {
      wordSpans.forEach(s => s.classList.remove('active'));
      userScrolled = false;
    });
    
    // Show metadata
    meta.textContent = `${data.metadata.words} words • ${data.voice} • ${(data.metadata.duration_ms / 1000).toFixed(1)}s`;
  }
  
  static loadFromUrl(url, audio, highlight, meta) {
    fetch(url)
      .then(res => res.json())
      .then(data => TTSPlayer.loadFromData(data, audio, highlight, meta))
      .catch(err => meta.textContent = 'Error loading data: ' + err.message);
  }
  
  static base64ToBlob(b64, contentType) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: contentType });
  }
}

// Auto-initialize if data-tts-player attribute exists
document.addEventListener('DOMContentLoaded', () => {
  const elements = document.querySelectorAll('[data-tts-player]');
  elements.forEach(el => {
    const url = el.getAttribute('data-tts-player');
    if (url) {
      TTSPlayer.init({ container: el, url });
    }
  });
});
