export interface DailyThought {
  id: string;
  zh: {
    quote: string;
    author: string;
    note: string;
  };
  en: {
    quote: string;
    author: string;
    note: string;
  };
}

export const DAILY_THOUGHTS: DailyThought[] = [
  {
    id: "dt-001",
    zh: { quote: "慢即是快", author: "老子《道德经》", note: "急于求成往往欲速不达，慢下来才能看清全局。" },
    en: { quote: "Slow is fast", author: "Lao Tzu, Tao Te Ching", note: "Rushing often backfires; slowing down reveals the whole board." },
  },
  {
    id: "dt-002",
    zh: { quote: "三思而后行", author: "《论语·公冶长》", note: "重大判断前，先让念头经过三次审视。" },
    en: { quote: "Think thrice before you act", author: "The Analects", note: "Before a major decision, let the thought pass through three layers of scrutiny." },
  },
  {
    id: "dt-003",
    zh: { quote: "知己知彼，百战不殆", author: "孙子《孙子兵法》", note: "了解现状与自身立场，比急着出招更重要。" },
    en: { quote: "Know yourself and know your enemy", author: "Sun Tzu, The Art of War", note: "Understanding the situation and your own position matters more than rushing to move." },
  },
  {
    id: "dt-004",
    zh: { quote: "知行合一", author: "王阳明", note: "真正的知道会自然导向恰当的行动；若行动迟疑，往往是因为知道得还不够深。" },
    en: { quote: "Knowledge and action are one", author: "Wang Yangming", note: "True knowing leads naturally to fitting action; hesitation often means the knowing is still shallow." },
  },
  {
    id: "dt-005",
    zh: { quote: "结硬寨，打呆仗", author: "曾国藩", note: "把基本功做扎实，胜过追求花招与速胜。" },
    en: { quote: "Build solid camps, fight dull battles", author: "Zeng Guofan", note: "Solid fundamentals beat flashy shortcuts and quick wins." },
  },
  {
    id: "dt-006",
    zh: { quote: "格物致知", author: "《礼记·大学》", note: "从事物的细节中推究原理，判断自然有根有据。" },
    en: { quote: "Investigate things to extend knowledge", author: "The Book of Rites", note: "Sound judgment grows from careful examination of particulars." },
  },
  {
    id: "dt-007",
    zh: { quote: "不积跬步，无以至千里", author: "荀子《劝学》", note: "长期主义不是一次大动作，而是持续小步的累积。" },
    en: { quote: "Without accumulating steps, one cannot reach a thousand li", author: "Xunzi", note: "Long-termism is not one grand move, but the steady accumulation of small steps." },
  },
  {
    id: "dt-008",
    zh: { quote: "志不强者智不达", author: "墨子", note: "方向不清时，才智只会四处耗散。" },
    en: { quote: "Without strong purpose, intelligence cannot reach far", author: "Mozu", note: "When direction is unclear, talent scatters." },
  },
  {
    id: "dt-009",
    zh: { quote: "千里之堤，溃于蚁穴", author: "《韩非子》", note: "小偏差若不及时处理，终将演变成大风险。" },
    en: { quote: "A thousand-mile dike collapses from an ant hole", author: "Han Feizi", note: "Small deviations, left unattended, grow into large risks." },
  },
  {
    id: "dt-010",
    zh: { quote: "吾生也有涯，而知也无涯", author: "庄子《养生主》", note: "承认无知，是谨慎决策的起点。" },
    en: { quote: "Life is finite, but knowledge is infinite", author: "Zhuangzi", note: "Acknowledging ignorance is the beginning of prudent judgment." },
  },
  {
    id: "dt-011",
    zh: { quote: "我思故我在", author: "笛卡尔", note: "在行动之前，先确认自己真正理解了什么。" },
    en: { quote: "I think, therefore I am", author: "René Descartes", note: "Before acting, verify what you actually understand." },
  },
  {
    id: "dt-012",
    zh: { quote: "认识你自己", author: "苏格拉底", note: "最难的判断，是看清自己在这场决策中的偏见。" },
    en: { quote: "Know thyself", author: "Socrates", note: "The hardest judgment is seeing your own bias in the decision." },
  },
  {
    id: "dt-013",
    zh: { quote: "优秀不是一种行为，而是一种习惯", author: "亚里士多德", note: "治理的质量，来自反复做对的系统，而非一次灵光乍现。" },
    en: { quote: "Excellence is not an act, but a habit", author: "Aristotle", note: "Good governance comes from systems that repeatedly do the right thing, not from one bright insight." },
  },
  {
    id: "dt-014",
    zh: { quote: "反过来想，总是反过来想", author: "查理·芒格", note: "先问自己什么会导致失败，再决定如何前进。" },
    en: { quote: "Invert, always invert", author: "Charlie Munger", note: "Ask what would cause failure before deciding how to proceed." },
  },
  {
    id: "dt-015",
    zh: { quote: "风会熄灭蜡烛，却能使火堆烧得更旺", author: "纳西姆·塔勒布", note: "随机波动会摧毁脆弱的东西，也会让抗脆弱的系统变得更强。" },
    en: { quote: "Wind extinguishes a candle and energizes a fire", author: "Nassim Taleb", note: "Randomness destroys the fragile and strengthens the antifragile." },
  },
  {
    id: "dt-016",
    zh: { quote: "思考，快与慢", author: "丹尼尔·卡尼曼", note: "重要决策别让直觉独占舞台，给慢思考留出时间。" },
    en: { quote: "Thinking, fast and slow", author: "Daniel Kahneman", note: "For important decisions, do not let intuition take the whole stage; give slow thinking its time." },
  },
  {
    id: "dt-017",
    zh: { quote: "真正的学习来自行动后的反思", author: "彼得·圣吉", note: "没有复盘的经验只是经历，不会自动变成能力。" },
    en: { quote: "Real learning comes from reflection after action", author: "Peter Senge", note: "Experience without review remains mere occurrence; it does not automatically become capability." },
  },
  {
    id: "dt-018",
    zh: { quote: "痛苦 + 反思 = 进步", author: "雷·达里奥", note: "把每一次偏差都当作反馈，而不是失败。" },
    en: { quote: "Pain + reflection = progress", author: "Ray Dalio", note: "Treat every deviation as feedback, not failure." },
  },
  {
    id: "dt-019",
    zh: { quote: "如果我有1小时来解决一个问题，我会花55分钟思考问题本身", author: "爱因斯坦", note: "定义问题所花的时间，会直接决定解决方案的质量。" },
    en: { quote: "If I had an hour to solve a problem, I would spend 55 minutes defining it", author: "Albert Einstein", note: "The time spent defining a problem directly determines the quality of the solution." },
  },
  {
    id: "dt-020",
    zh: { quote: "风险来自于你不知道自己在做什么", author: "沃伦·巴菲特", note: "承认自己不懂，比假装懂更安全。" },
    en: { quote: "Risk comes from not knowing what you are doing", author: "Warren Buffett", note: "Admitting you do not understand is safer than pretending you do." },
  },
  {
    id: "dt-021",
    zh: { quote: "Stay hungry, stay foolish", author: "史蒂夫·乔布斯", note: "保持好奇与谦逊，才能看见旧假设之外的新可能。" },
    en: { quote: "Stay hungry, stay foolish", author: "Steve Jobs", note: "Curiosity and humility let you see possibilities beyond old assumptions." },
  },
  {
    id: "dt-022",
    zh: { quote: "命运引导愿意的人，也会拖走不情愿的人", author: "塞涅卡", note: "长期趋势不会等待任何人；主动顺应比被动抗拒更有力量。" },
    en: { quote: "Fate leads the willing and drags the unwilling", author: "Seneca", note: "Long-term trends wait for no one; willing alignment beats reluctant resistance." },
  },
  {
    id: "dt-023",
    zh: { quote: "你的生活由你的思想塑造", author: "马可·奥勒留", note: "先调整看待问题的方式，再调整行动。" },
    en: { quote: "Your life is shaped by your thoughts", author: "Marcus Aurelius", note: "Adjust how you see the problem before adjusting your action." },
  },
  {
    id: "dt-024",
    zh: { quote: "世界上最大的监狱，是人的思维", author: "叔本华", note: "当你只有一种解释框架时，每个问题看起来都似曾相识。" },
    en: { quote: "The greatest prison is the mind", author: "Arthur Schopenhauer", note: "When you have only one frame, every problem looks familiar." },
  },
  {
    id: "dt-025",
    zh: { quote: "我的语言的界限意味着我的世界的界限", author: "维特根斯坦", note: "说不清的问题，往往是因为还没有真正理解它。" },
    en: { quote: "The limits of my language mean the limits of my world", author: "Ludwig Wittgenstein", note: "What you cannot articulate clearly, you have not yet truly understood." },
  },
  {
    id: "dt-026",
    zh: { quote: "科学始于问题", author: "卡尔·波普尔", note: "好的判断从提出可证伪的问题开始，而不是寻找确认的证据。" },
    en: { quote: "Science starts with problems", author: "Karl Popper", note: "Good judgment begins with falsifiable questions, not with confirming evidence." },
  },
  {
    id: "dt-027",
    zh: { quote: "人类是有限理性的动物", author: "赫伯特·西蒙", note: "不要追求最优解，追求在信息和时间内足够好的解。" },
    en: { quote: "Humans are boundedly rational", author: "Herbert Simon", note: "Do not seek the optimal solution; seek one good enough within the information and time available." },
  },
  {
    id: "dt-028",
    zh: { quote: "市场保持非理性的时间，可能比你保持偿付能力的时间更长", author: "约翰·梅纳德·凯恩斯", note: "不要和系统僵持；先活下来，再等待正确的时机。" },
    en: { quote: "The market can stay irrational longer than you can stay solvent", author: "John Maynard Keynes", note: "Do not fight the system head-on; survive first, then wait for the right moment." },
  },
  {
    id: "dt-029",
    zh: { quote: "有些事情在我们的控制之内，有些不在", author: "爱比克泰德", note: "把精力花在可控的事上，对不可控的事保持接纳。" },
    en: { quote: "Some things are within our control, others are not", author: "Epictetus", note: "Spend energy on what you can control; accept what you cannot." },
  },
  {
    id: "dt-030",
    zh: { quote: "告诉我，我会忘记；教我，我会记住；让我参与，我会学会", author: "本杰明·富兰克林", note: "真正内化的原则，来自亲身参与和反复实践。" },
    en: { quote: "Tell me and I forget; teach me and I remember; involve me and I learn", author: "Benjamin Franklin", note: "Principles are truly internalized through participation and repeated practice." },
  },
];

export function getDailyThoughtIndex(thoughts: readonly DailyThought[], dateString: string): number {
  if (thoughts.length === 0) {
    return -1;
  }

  let hash = 2166136261;
  for (let i = 0; i < dateString.length; i++) {
    hash ^= dateString.charCodeAt(i);
    // FNV-1a 32-bit prime multiplication
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }

  return Math.abs(hash) % thoughts.length;
}
