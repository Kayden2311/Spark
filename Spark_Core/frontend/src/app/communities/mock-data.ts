export interface CommunityTopic {
  title: string;
  author: string;
  replies: number;
  time: string;
}

export interface CommunityEvent {
  title: string;
  date: string;
  time: string;
  format: string;
}

export interface Community {
  slug: string;
  name: string;
  topic: string;
  category: "B2B SaaS" | "Climate Tech" | "AI & Data" | "Product" | "FinTech" | "Founders Circle";
  location: string;
  stage: "Idea to Pre-seed" | "Pre-seed to Seed" | "Seed to Series A" | "Growth" | "Any stage";
  members: string;
  memberCount: number;
  description: string;
  longDescription: string;
  activity: string;
  initials: string;
  gradient: string;
  featured?: boolean;
  tags: string[];
  host: {
    name: string;
    role: string;
  };
  recentTopics: CommunityTopic[];
  upcomingEvents: CommunityEvent[];
}

export const communities: Community[] = [
  {
    slug: "northstar-founders",
    name: "Northstar Founders",
    topic: "B2B SaaS",
    category: "B2B SaaS",
    location: "Ho Chi Minh City",
    stage: "Seed to Series A",
    members: "186 founders",
    memberCount: 186,
    description: "A working community for founders building and selling B2B software across Southeast Asia.",
    longDescription:
      "Northstar Founders connects cross-border B2B software operators. We discuss enterprise GTM playbooks, inbound pipeline generation, pricing tiers, and fundraising rounds with active regional VCs.",
    activity: "Founder session this Thursday at 7:00 PM",
    initials: "NF",
    gradient: "linear-gradient(135deg, #2563eb, #1d4ed8)",
    featured: true,
    tags: ["Enterprise GTM", "B2B SaaS", "Pricing", "Seed/Series A"],
    host: {
      name: "Minh Tran",
      role: "Founder & Community Lead",
    },
    recentTopics: [
      { title: "Transitioning from founder-led sales to first 2 account executives", author: "Minh Tran", replies: 14, time: "2h ago" },
      { title: "2026 ACV benchmarks for regional SaaS selling to Singapore & VN enterprises", author: "Huyen Nguyen", replies: 8, time: "Yesterday" },
      { title: "Best cold outbound tech stacks with deliverability tooling", author: "Alex Do", replies: 19, time: "3d ago" },
    ],
    upcomingEvents: [
      { title: "Monthly Founder AMA: Scaling from $10k to $50k MRR", date: "Thu, Sep 24", time: "7:00 PM GMT+7", format: "Live Circle Room" },
      { title: "Enterprise Pricing Tear-Down Workshop", date: "Wed, Oct 02", time: "6:30 PM GMT+7", format: "Virtual" },
    ],
  },
  {
    slug: "climate-builders",
    name: "Climate Builders",
    topic: "Climate tech",
    category: "Climate Tech",
    location: "Hanoi",
    stage: "Pre-seed to Seed",
    members: "94 builders",
    memberCount: 94,
    description: "Operators and founders turning climate problems into practical products and partnerships.",
    longDescription:
      "A tight-knit circle for decarbonization engineers, carbon accounting developers, and renewable energy founders in Vietnam and Southeast Asia.",
    activity: "New partnership introductions this week",
    initials: "CB",
    gradient: "linear-gradient(135deg, #059669, #0d9488)",
    featured: true,
    tags: ["Climate Tech", "Decarbonization", "Carbon Accounting", "Circular Economy"],
    host: {
      name: "Anh Pham",
      role: "Climate Tech Operator",
    },
    recentTopics: [
      { title: "Scope 3 emissions measurement challenges for local supply chains", author: "Anh Pham", replies: 11, time: "5h ago" },
      { title: "Grant funding opportunities in APAC climate innovation", author: "Duc Le", replies: 6, time: "2d ago" },
    ],
    upcomingEvents: [
      { title: "Climate Tech Showcase: Energy & Material Startups", date: "Fri, Sep 26", time: "5:00 PM GMT+7", format: "Hanoi & Virtual" },
    ],
  },
  {
    slug: "product-practice",
    name: "Product Practice",
    topic: "Product Management",
    category: "Product",
    location: "Remote · Vietnam",
    stage: "Any stage",
    members: "241 leaders",
    memberCount: 241,
    description: "A peer group for product leaders who want sharper discovery, delivery, and feedback loops.",
    longDescription:
      "Product Practice is an invitation-backed peer group where Head of Products, Lead PMs, and founders discuss real product delivery systems, roadmapping frameworks, and user interview cadences.",
    activity: "Monthly product critique opens Friday",
    initials: "PP",
    gradient: "linear-gradient(135deg, #7c3aed, #6366f1)",
    featured: true,
    tags: ["Product Strategy", "Discovery", "Roadmapping", "Sprint Systems"],
    host: {
      name: "Thao Vu",
      role: "VP of Product",
    },
    recentTopics: [
      { title: "Balancing technical debt vs core roadmap in high-pace release cycles", author: "Thao Vu", replies: 23, time: "3h ago" },
      { title: "Continuous user interview cadence with 2-week sprint cadences", author: "Quang Le", replies: 17, time: "1d ago" },
    ],
    upcomingEvents: [
      { title: "Product Teardown: Onboarding Funnels that Retain", date: "Fri, Sep 25", time: "8:00 PM GMT+7", format: "Virtual Jam" },
    ],
  },
  {
    slug: "ai-applied-engineers",
    name: "AI Applied Engineers",
    topic: "AI & DeepTech",
    category: "AI & Data",
    location: "Ho Chi Minh City",
    stage: "Idea to Pre-seed",
    members: "312 engineers",
    memberCount: 312,
    description: "Engineers and founders building vertical agentic workflows, LLM apps, and vector pipelines.",
    longDescription:
      "A high-velocity technical forum focused on productionizing LLMs, agent evaluation benchmarks, fast inference infrastructure, and domain-specific knowledge graphs.",
    activity: "Agent benchmark session Wednesday",
    initials: "AE",
    gradient: "linear-gradient(135deg, #0284c7, #2563eb)",
    featured: false,
    tags: ["AI Agents", "LLM Evals", "FastAPI", "Vector DBs"],
    host: {
      name: "Khoa Dang",
      role: "AI Tech Lead",
    },
    recentTopics: [
      { title: "Reducing hallucination in automated legal & financial parsing pipelines", author: "Khoa Dang", replies: 31, time: "4h ago" },
      { title: "Evaluating local vs hosted inference latency for real-time copilots", author: "Bao Nguyen", replies: 15, time: "Yesterday" },
    ],
    upcomingEvents: [
      { title: "Building Production Agents: Memory, Tools, and Safety Rails", date: "Wed, Oct 01", time: "7:30 PM GMT+7", format: "HCMC Hub" },
    ],
  },
  {
    slug: "fintech-builders-hub",
    name: "FinTech Builders Hub",
    topic: "FinTech & Payments",
    category: "FinTech",
    location: "Hanoi",
    stage: "Seed to Series A",
    members: "148 members",
    memberCount: 148,
    description: "Founders and compliance leaders navigating digital payments, lending rails, and banking APIs.",
    longDescription:
      "Navigating compliance, open banking regulations, KYC workflows, and payment gateway architectures across developing financial markets in SEA.",
    activity: "State of Regulatory Sandboxes roundtable next week",
    initials: "FB",
    gradient: "linear-gradient(135deg, #d97706, #b45309)",
    featured: false,
    tags: ["Digital Payments", "KYC / AML", "Open Banking", "Lending Rails"],
    host: {
      name: "Son Hoang",
      role: "FinTech Regulatory Advisor",
    },
    recentTopics: [
      { title: "Reconciliation automation for multi-gateway settlement flows", author: "Son Hoang", replies: 9, time: "1d ago" },
      { title: "Sandbox regulatory requirements for alternative credit scoring", author: "Linh Mai", replies: 12, time: "3d ago" },
    ],
    upcomingEvents: [
      { title: "State of Southeast Asian FinTech Regulation 2026", date: "Tue, Oct 07", time: "6:00 PM GMT+7", format: "Hybrid" },
    ],
  },
  {
    slug: "early-stage-founders-circle",
    name: "Early-Stage Founders Circle",
    topic: "Founder Circles",
    category: "Founders Circle",
    location: "Remote · Vietnam",
    stage: "Idea to Pre-seed",
    members: "275 founders",
    memberCount: 275,
    description: "Zero-to-one founders sharing sprint cadences, pitch decks, and customer discovery insights.",
    longDescription:
      "A candid, high-trust circle for first-time founders finding product-market fit, structuring initial co-founder equity, and executing their first 50 customer interviews.",
    activity: "Sprint check-in every Monday morning",
    initials: "EF",
    gradient: "linear-gradient(135deg, #db2777, #9333ea)",
    featured: true,
    tags: ["Zero-to-One", "Customer Discovery", "Co-founders", "Pitch Decks"],
    host: {
      name: "Trang Nguyen",
      role: "Incubator Mentor",
    },
    recentTopics: [
      { title: "How we landed our first 5 paying pilot customers without paid ads", author: "Trang Nguyen", replies: 28, time: "6h ago" },
      { title: "Founder vesting schedules and cap table hygiene for pre-seed startups", author: "Viet Pham", replies: 14, time: "2d ago" },
    ],
    upcomingEvents: [
      { title: "Weekly Zero-to-One Accountability Sprint Kickoff", date: "Mon, Sep 22", time: "9:00 AM GMT+7", format: "Spark Audio Room" },
    ],
  },
];
