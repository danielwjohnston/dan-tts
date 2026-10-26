"""Hosted voice providers behind the server's provider seam.

Each module is a URL, a key and an adapter: `PREFIX`/`ID_RE` for its voice ids, `configured()`,
`list_voices()` in the shape /voices returns, and `synthesize(text, voice)` → (mp3 bytes, word
boundaries in 100 ns ticks). worker/src/ has the same adapters for the Cloudflare Worker; change both together.
"""
