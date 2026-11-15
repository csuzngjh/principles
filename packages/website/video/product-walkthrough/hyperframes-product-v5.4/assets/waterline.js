// A surface seen edge-on. Sample two damped wave packets traveling away from each impact.
window.animateWaterline = (timeline, path, { left, right, y, impacts }) => {
  const start = impacts[0].at;
  const last = impacts.at(-1);
  const duration = last.at + last.duration - start;
  const playhead = { seconds: 0 };
  const flat = `M ${left} ${y} H ${right}`;

  function packet(offset, width) {
    if (Math.abs(offset) >= width) return 0;
    const envelope = (1 + Math.cos(Math.PI * offset / width)) / 2;
    return envelope * Math.cos(2 * Math.PI * offset / 158);
  }

  function draw() {
    const time = start + playhead.seconds;
    const impact = impacts.find(({ at, duration }) => time > at && time < at + duration);
    if (!impact) {
      path.setAttribute("d", flat);
      return;
    }

    const elapsed = time - impact.at;
    const distance = Math.max(0, elapsed - 0.035) * impact.speed;
    const width = 76 + Math.min(80, elapsed * 340);
    const attack = 1 - Math.exp(-50 * elapsed);
    const decay = Math.exp(-1.12 * elapsed);
    const release = Math.min(1, (impact.duration - elapsed) / 0.33);
    const amplitude = 52 * attack * decay * release;

    const points = [`M ${left} ${y}`];
    for (let x = left + 8; x < right; x += 8) {
      const offset = x - impact.x;
      const edge = Math.min(1, (x - left) / 44, (right - x) / 44);
      const displacement = amplitude * edge * (
        packet(offset - distance, width) + packet(offset + distance, width)
      ) / 2;
      points.push(`L ${x} ${(y + displacement).toFixed(2)}`);
    }
    points.push(`L ${right} ${y}`);
    path.setAttribute("d", points.join(" "));
  }

  timeline.fromTo(playhead, { seconds: 0 }, {
    seconds: duration, duration, ease: "none", onUpdate: draw,
  }, start);
};
