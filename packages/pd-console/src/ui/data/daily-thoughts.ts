export interface DailyThought {
  id: string;
  sourceUrl?: string;
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
    sourceUrl: "https://zh.wikisource.org/wiki/道德經_(王弼本)",
    zh: { quote: "知人者智，自知者明。", author: "老子《道德经》第三十三章", note: "判断之前，先想想自己的经验和好恶，会让哪些证据显得格外可信。" },
    en: { quote: "Knowing others is wisdom. Knowing yourself is clarity.", author: "Laozi · Tao Te Ching, ch. 33", note: "Before deciding, notice which evidence feels persuasive because it fits your own experience or preferences." },
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
    sourceUrl: "https://zh.wikisource.org/wiki/傳習錄/卷上",
    zh: { quote: "知是行之始，行是知之成。", author: "王阳明《传习录》卷上", note: "如果这条原则真的被理解，下次遇到相同情境时，哪一步行为会改变？" },
    en: { quote: "Knowing is the beginning of action. Action is the fulfillment of knowing.", author: "Wang Yangming · Instructions for Practical Living, vol. 1", note: "If this principle is understood, what step should change the next time the situation occurs?" },
  },
  {
    id: "dt-005",
    sourceUrl: "https://ctext.org/wiki.pl?chapter=809564&if=en",
    zh: { quote: "第一要有志，第二要有识，第三要有恒。", author: "曾国藩《曾国藩家书》", note: "先想清想养成什么，再用证据校准方向，并约定何时回来复看。" },
    en: { quote: "First, have purpose. Second, have discernment. Third, persevere.", author: "Zeng Guofan · Family Letters", note: "Name the habit you want to cultivate, check your direction against the evidence, and choose when to revisit it." },
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
    sourceUrl: "https://classics.mit.edu/Aristotle/nicomachaen.2.ii.html",
    zh: { quote: "我们通过行正义之事而成为正义的人。", author: "亚里士多德《尼各马可伦理学》第二卷（译）", note: "判断一种行为是否成了习惯，要看它在相似情境里能否重复出现。" },
    en: { quote: "We become just by doing just acts.", author: "Aristotle · Nicomachean Ethics, book II", note: "To judge whether a behavior has become a habit, look for it across similar situations." },
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
    sourceUrl: "https://www.gutenberg.org/files/37423/37423-h/37423-h.htm",
    zh: { quote: "反思，是审慎地检查一个信念的依据，以及它会导向什么结论。", author: "约翰·杜威《我们如何思考》（意译）", note: "批准之前，问问自己：这条原则依据哪一条观察？持续应用它，又可能带来什么后果？" },
    en: { quote: "Reflection examines the grounds for a belief and the conclusions it leads to.", author: "John Dewey · How We Think (paraphrase)", note: "Before approving, ask which observation supports this principle and what effects it could have if applied repeatedly." },
  },
  {
    id: "dt-018",
    zh: { quote: "痛苦 + 反思 = 进步", author: "雷·达里奥", note: "把每一次偏差都当作反馈，而不是失败。" },
    en: { quote: "Pain + reflection = progress", author: "Ray Dalio", note: "Treat every deviation as feedback, not failure." },
  },
  {
    id: "dt-019",
    sourceUrl: "https://www.gutenberg.org/files/2010/2010-h/2010-h.htm",
    zh: { quote: "遇到与我的总体结论相悖的事实、观察或想法，我就立即记下来。", author: "达尔文《自传》（节译）", note: "先记下最不符合预期的那条记录，再看原来的判断是否仍站得住。" },
    en: { quote: "Whenever a fact, observation, or thought contradicted my general conclusions, I made a point of writing it down at once.", author: "Charles Darwin · Autobiography (paraphrase)", note: "Write down the most surprising observation first. Then ask whether your original conclusion still holds." },
  },
  {
    id: "dt-020",
    zh: { quote: "风险来自于你不知道自己在做什么", author: "沃伦·巴菲特", note: "承认自己不懂，比假装懂更安全。" },
    en: { quote: "Risk comes from not knowing what you are doing", author: "Warren Buffett", note: "Admitting you do not understand is safer than pretending you do." },
  },
  {
    id: "dt-021",
    sourceUrl: "https://news.stanford.edu/stories/2005/06/youve-got-find-love-jobs-says",
    zh: { quote: "Stay hungry. Stay foolish.", author: "《全球概览》，乔布斯转引", note: "保持一点好奇，问问现有解释之外，还有哪一种可能值得检查。" },
    en: { quote: "Stay hungry. Stay foolish.", author: "The Whole Earth Catalog, quoted by Steve Jobs", note: "Stay curious enough to check one explanation beyond the one you already favor." },
  },
  {
    id: "dt-022",
    zh: { quote: "命运引导愿意的人，也会拖走不情愿的人", author: "塞涅卡", note: "长期趋势不会等待任何人；主动顺应比被动抗拒更有力量。" },
    en: { quote: "Fate leads the willing and drags the unwilling", author: "Seneca", note: "Long-term trends wait for no one; willing alignment beats reluctant resistance." },
  },
  {
    id: "dt-023",
    zh: { quote: "您的生活由您的思想塑造", author: "马可·奥勒留", note: "先调整看待问题的方式，再调整行动。" },
    en: { quote: "Your life is shaped by your thoughts", author: "Marcus Aurelius", note: "Adjust how you see the problem before adjusting your action." },
  },
  {
    id: "dt-024",
    sourceUrl: "https://zh.wikisource.org/wiki/道德經_(王弼本)",
    zh: { quote: "慎终如始，则无败事。", author: "老子《道德经》第六十四章", note: "即使原则已经生效，也要重新看看实际行为以及最初担心的副作用。" },
    en: { quote: "Be as careful at the end as at the beginning.", author: "Laozi · Tao Te Ching, ch. 64 (excerpt)", note: "Once a principle is active, revisit the actual behavior and the side effects you originally anticipated." },
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
    sourceUrl: "https://zh.wikisource.org/wiki/論語/爲政第二",
    zh: { quote: "知之为知之，不知为不知，是知也。", author: "孔子《论语·为政》", note: "把已经观察到的事实和仍待查证的推断分开，再判断证据够不够。" },
    en: { quote: "Recognize what you know and what you do not know. That is knowledge.", author: "Confucius · Analects, book II", note: "Separate observations from inferences before deciding whether you have enough evidence." },
  },
  {
    id: "dt-031",
    sourceUrl: "https://zh.wikisource.org/wiki/傳習錄/卷上",
    zh: { quote: "未有知而不行者；知而不行，只是未知。", author: "王阳明《传习录》卷上", note: "想一想：智能体能复述这条原则时，你还要观察到什么行为，才算它学会了？" },
    en: { quote: "Knowing without acting is still not knowing.", author: "Wang Yangming · Instructions for Practical Living, vol. 1 (paraphrase)", note: "The agent can repeat the principle. What behavior would show that it has learned it?" },
  },
  {
    id: "dt-032",
    sourceUrl: "https://zh.wikisource.org/wiki/道德經_(王弼本)",
    zh: { quote: "为之于未有，治之于未乱。", author: "老子《道德经》第六十四章", note: "留意失误发生前有什么征兆。好的原则可以在那一步提供具体帮助。" },
    en: { quote: "Act before trouble arises. Put things in order before disorder sets in.", author: "Laozi · Tao Te Ching, ch. 64", note: "Look for the warning sign that came before the mistake. A principle can help at that specific moment." },
  },
  {
    id: "dt-033",
    sourceUrl: "https://upload.wikimedia.org/wikipedia/commons/a/ae/SSID-13743286_曾國藩家書.pdf",
    zh: { quote: "求友人以匡己之不逮，此大益也。", author: "曾国藩《曾国藩家书》", note: "找一条自己可能忽略的反例，看看它会不会改变你对这条原则的看法。" },
    en: { quote: "It is a great benefit to seek friends who help correct our shortcomings.", author: "Zeng Guofan · Family Letters", note: "Find a counterexample you might have overlooked and ask whether it changes your view of the principle." },
  },
  {
    id: "dt-034",
    sourceUrl: "https://classics.mit.edu/Epictetus/epicench.html",
    zh: { quote: "先看眼前的印象是否符合事实。", author: "爱比克泰德《手册》第 1 节（意译）", note: "一段描述很可信时，回到原始记录，找出支持它的具体行为。" },
    en: { quote: "Test whether the impression matches what actually happened.", author: "Epictetus · Enchiridion, §1 (paraphrase)", note: "When a description sounds convincing, look up the specific behavior in the original record." },
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
