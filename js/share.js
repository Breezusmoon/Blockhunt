/* BlockHunt — shareable result card (PNG) + share links */
const SITE_URL = 'https://breezusmoon.github.io/Blockhunt/'

function shareLink() {
  // Connected players share their invite link, so friends who enter earn them 2%
  return SITE_URL + (wallet ? '?ref=' + wallet : '')
}

function loadImg(src) {
  return new Promise(res => {
    const i = new Image()
    i.onload = () => res(i)
    i.onerror = () => res(null)
    i.src = src
  })
}

async function drawShareCard() {
  const d = lastShareData || {}
  const W = 1080
  const H = 1350
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const x = c.getContext('2d')
  const bg = x.createLinearGradient(0, 0, W, H)
  bg.addColorStop(0, '#0b0518')
  bg.addColorStop(1, '#04020a')
  x.fillStyle = bg
  x.fillRect(0, 0, W, H)

  // glow + grid
  const glow = x.createRadialGradient(W / 2, 520, 40, W / 2, 520, 620)
  glow.addColorStop(0, 'rgba(255,126,0,.35)')
  glow.addColorStop(1, 'rgba(255,126,0,0)')
  x.fillStyle = glow
  x.fillRect(0, 0, W, H)
  x.strokeStyle = 'rgba(157,78,221,.12)'
  x.lineWidth = 2
  for (let i = 0; i <= W; i += 60) {
    x.beginPath()
    x.moveTo(i, 0)
    x.lineTo(i, H)
    x.stroke()
  }

  // character portrait
  const ch = CHARACTERS[profile.charId || 'owl'] || CHARACTERS.owl
  const portrait = await loadImg(ch.img)
  if (portrait) {
    x.save()
    x.beginPath()
    x.arc(W / 2, 330, 190, 0, Math.PI * 2)
    x.clip()
    const s = 380 / portrait.width
    x.drawImage(portrait, W / 2 - 190, 140, 380, portrait.height * s)
    x.restore()
    x.strokeStyle = '#ff7e00'
    x.lineWidth = 10
    x.beginPath()
    x.arc(W / 2, 330, 190, 0, Math.PI * 2)
    x.stroke()
  }

  x.textAlign = 'center'
  x.fillStyle = '#ffb000'
  x.font = '900 92px Orbitron, Arial Black, sans-serif'
  x.fillText('BLOCKHUNT', W / 2, 640)
  x.fillStyle = 'rgba(255,255,255,.7)'
  x.font = '700 38px Rajdhani, Arial, sans-serif'
  const ml = DCFG[diff] ? DCFG[diff].label.toUpperCase() : ''
  const label = isDailyMode ? 'DAILY CHALLENGE' : v1Data ? '1V1 CHALLENGE' : training ? ml + ' PRACTICE' : ml + ' TOURNAMENT'
  x.fillText(label, W / 2, 700)

  x.fillStyle = '#ffffff'
  x.font = '900 230px Orbitron, Arial Black, sans-serif'
  x.fillText(d.time || '--', W / 2, 950)
  x.fillStyle = '#22c55e'
  x.font = '700 46px Rajdhani, Arial, sans-serif'
  x.fillText(`${d.words || 0} words  ·  ${d.wpm || 0} words/min  ·  🔥 ${streak} streak`, W / 2, 1040)

  x.fillStyle = '#ff7e00'
  x.font = '900 54px Orbitron, Arial Black, sans-serif'
  x.fillText('CAN YOU BEAT IT?', W / 2, 1170)
  x.fillStyle = 'rgba(255,255,255,.55)'
  x.font = '600 36px Rajdhani, Arial, sans-serif'
  x.fillText('breezusmoon.github.io/Blockhunt  ·  Avalanche', W / 2, 1240)
  return new Promise(res => c.toBlob(res, 'image/png'))
}

async function shareImage() {
  const blob = await drawShareCard()
  if (!blob) return toast('Could not make the image', true)
  const file = new File([blob], 'blockhunt-' + (lastShareData.time || 'score').replace(/[^0-9a-z.]/gi, '') + '.png', { type: 'image/png' })
  const text = `I found every word in ${lastShareData.time} on BlockHunt 🦉 Can you beat it?`
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], text, url: shareLink() })
      return
    }
  } catch (e) {
    if (e.name === 'AbortError') return
  }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = file.name
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    URL.revokeObjectURL(a.href)
    a.remove()
  }, 1000)
  toast('🖼 Image saved — post it anywhere')
}
