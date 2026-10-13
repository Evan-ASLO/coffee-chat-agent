interface TechnicalTrack {
	label: string;
	aliases: string[];
	pattern: RegExp;
	role: string;
	keyword: string;
}

const tracks: TechnicalTrack[] = [
	{ label: "Quality & Test Engineering", aliases: ["qa", "quality assurance", "quality engineer", "sdet", "software test", "system test", "test automation", "verification", "validation", "v&v", "systems integration & test"],
		pattern: /\b(?:sdet|qa|quality assurance|quality engineer|test engineer(?:ing)?|test automation|(?:software|systems?) test|verification|validation)\b/i, role: "Test Engineer", keyword: "test engineering" },
	{ label: "Cybersecurity", aliases: ["cyber", "cybersecurity", "information security", "application security", "product security", "security engineer", "threat", "soc", "iam"],
		pattern: /\b(?:cyber(?:security)?|(?:information|application|product|browser|network|cloud) security|security engineer|threat|soc|iam)\b/i, role: "Security Engineer", keyword: "cybersecurity" },
	{ label: "Data Science & AI", aliases: ["data science", "data scientist", "data engineer", "data engineering", "data analyst", "analytics", "bi", "business intelligence", "ai", "artificial intelligence", "ml", "machine learning", "applied science", "applied research", "nlp", "genai", "computer vision"],
		pattern: /\b(?:data (?:science|scientist|engineer(?:ing)?|analyst|analytics|quality)|analytics|business intelligence|machine learning|artificial intelligence|applied (?:science|scientist|research)|nlp|genai|computer vision)\b|\b(?:ai|ml|bi)\b/i, role: "Data Engineer", keyword: "data science" },
	{ label: "Hardware & Embedded Systems", aliases: ["hardware", "embedded", "firmware", "fpga", "asic", "soc", "silicon", "pcb", "microelectronics", "computer engineering"],
		pattern: /\b(?:hardware|embedded|firmware|fpga|asic|silicon|pcb|microelectronics|computer engineer(?:ing)?)\b/i, role: "Embedded Engineer", keyword: "hardware engineering" },
	{ label: "IT & Infrastructure", aliases: ["it", "information technology", "information systems", "cloud", "devops", "sre", "site reliability", "infrastructure engineer", "platform", "network", "systems administrator", "systems engineer", "telecom", "data centre", "data center"],
		pattern: /\b(?:it|information (?:technology|systems)|cloud|devops|sre|site reliability|infrastructure engineer|platform engineer|network(?:ing)?|systems administrator|telecom|data cent(?:er|re))\b/i, role: "Infrastructure Engineer", keyword: "IT infrastructure" },
	{ label: "Software Engineering", aliases: ["software engineer", "software developer", "software development", "developer", "swe", "sde", "backend", "back-end", "frontend", "front-end", "full stack", "full-stack", "fullstack", "mobile", "ios", "android", "web developer", "application developer", "embedded developer", "systems development engineer", "developpeur logiciel", "developpeur logiciels", "developpeuse logiciel", "developpeuse logiciels", "developpement de logiciels"],
		pattern: /\b(?:software|developer|swe|sde|back.end|front.end|full.stack|ios|android)\b|d[eé]velopp(?:eur|euse|ement).*logiciel/i, role: "Software Engineer", keyword: "software engineering" },
	{ label: "Aerospace Engineering", aliases: ["aerospace", "aeronautical", "aircraft", "flight", "avionics", "propulsion", "satellite", "spacecraft"],
		pattern: /\b(?:aerospace|aeronautical|aircraft|flight|avionics|propulsion|satellite|spacecraft)\b/i, role: "Aerospace Engineer", keyword: "aerospace engineering" },
	{ label: "Biomedical Engineering", aliases: ["biomedical", "bioengineering", "medical device", "clinical engineering"],
		pattern: /\b(?:biomedical|bioengineer(?:ing)?|medical device|clinical engineer(?:ing)?)\b/i, role: "Biomedical Engineer", keyword: "biomedical engineering" },
	{ label: "Mining & Geological Engineering", aliases: ["mining", "geological", "mineral", "geoscience", "mine engineering"],
		pattern: /\b(?:mining|geological|minerals?|geoscience|mine engineer(?:ing)?)\b/i, role: "Mining Engineer", keyword: "mining engineering" },
	{ label: "Civil & Structural Engineering", aliases: ["civil", "structural", "construction engineering", "transportation", "tunnelling", "municipal", "rail", "geotechnical"],
		pattern: /\b(?:civil|structural|construction engineer(?:ing)?|transportation|tunnell?ing|municipal|rail|geotechnical)\b/i, role: "Civil Engineer", keyword: "civil engineering" },
	{ label: "Environmental Engineering", aliases: ["environmental engineering", "environmental compliance", "environmental support", "environmental reporting", "sustainability engineering", "forestry operations", "waste management", "environment, health & safety", "ehs"],
		pattern: /\b(?:environmental (?:engineer(?:ing)?|compliance|support|reporting)|sustainability engineer(?:ing)?|forestry operations|waste management|ehs)\b|\benvironment\s*,?\s*health\s*(?:&|and)\s*safety\b/i, role: "Environmental Engineer", keyword: "environmental engineering" },
	{ label: "Chemical, Process & Materials Engineering", aliases: ["chemical engineering", "chemical", "process engineering", "process engineer", "chemistry", "materials science", "materials innovation", "metallurgy", "battery", "polymer"],
		pattern: /\b(?:chemical|process engineer(?:ing)?|chemistry|materials (?:science|innovation|engineer(?:ing)?)|metallurgy|battery|polymer)\b/i, role: "Process Engineer", keyword: "process engineering" },
	{ label: "Industrial & Manufacturing Engineering", aliases: ["industrial", "industrial engineering", "manufacturing", "production engineering", "factory automation", "continuous improvement", "operations engineering"],
		pattern: /\b(?:(?:industrial|manufacturing|production|operations) engineer(?:ing)?|factory automation|continuous improvement)\b/i, role: "Manufacturing Engineer", keyword: "manufacturing engineering" },
	{ label: "Mechanical, Mechatronics & Robotics", aliases: ["mechanical", "mechatronics", "robotics", "electromechanical", "thermal", "fluids", "hvac", "mechanical automotive"],
		pattern: /\b(?:mechanical|mechatronic(?:s)?|robotic(?:s)?|electromechanical|thermal|fluids|hvac)\b/i, role: "Mechanical Engineer", keyword: "mechanical engineering" },
	{ label: "Electrical & Electronics Engineering", aliases: ["electrical", "electronics", "power systems", "grid", "transmission", "distribution", "control systems", "instrumentation"],
		pattern: /\b(?:electrical|electronics|power systems|control systems|instrumentation)\b/i, role: "Electrical Engineer", keyword: "electrical engineering" },
	{ label: "General Engineering", aliases: ["engineer", "engineering", "technologist", "project engineering", "field engineering", "systems engineering", "sales engineering", "nuclear"],
		pattern: /\b(?:engineer(?:ing)?|technologist|nuclear)\b/i, role: "Engineer", keyword: "engineering" },
];

const normalize = (value: string) => value.trim().toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
const aliases = new Map(tracks.flatMap((track) => [track.label, ...track.aliases].map((alias) => [normalize(alias), track.label] as const)));
const professionalAliases = new Map([
	{ label: "Legal, Compliance & Governance", aliases: ["legal", "legal operations", "legal administration", "legal admin", "contract management", "compliance", "corporate compliance", "corporate ethics", "governance", "corporate governance", "privacy", "data protection", "corporate secretarial", "law clerk", "paralegal", "legal regulatory affairs"] },
	{ label: "Public Policy & Government Relations", aliases: ["public policy", "government relations", "intergovernmental relations", "public affairs", "government affairs", "legislative research", "parliamentary research", "justice research", "advocacy", "human rights policy"] },
].flatMap((track) => [track.label, ...track.aliases].map((alias) => [normalize(alias), track.label] as const)));

export function canonicalCareerTrack(value: string): string {
	if (normalize(value) === "soc") return value.trim() === "SoC" ? "Hardware & Embedded Systems" : "Cybersecurity";
	return aliases.get(normalize(value)) || professionalAliases.get(normalize(value)) || value;
}

export function professionalKeywordTrack(value: string): string | undefined {
	return professionalAliases.get(normalize(value));
}

export function technicalKeywordTrack(value: string): string | undefined {
	return aliases.has(normalize(value)) ? canonicalCareerTrack(value) : undefined;
}

export function technicalRoleProfile(title: string): TechnicalTrack | undefined {
	if (/\b(?:business|financial) analyst\b|\b(?:business|financial|cfo)\b.*\bre.engineering\b|\b(?:physical security|security guard|data quality coach)\b/i.test(title)) return undefined;
	return tracks.find((track) => track.pattern.test(title));
}

export function technicalRoleNames(title: string, profile: TechnicalTrack): string[] {
	const role = title
		.replace(/\([^)]*\)/g, " ")
		.replace(/\b(?:internships?|intern|co[\s-]?op|cooperative|student|summer|winter|spring|fall|placement|20\d{2})\b/gi, " ")
		.replace(/\bengineering\b/gi, "Engineer")
		.replace(/\s*[-–—,|/]\s*$/g, "")
		.replace(/^\s*[-–—,|/]\s*/g, "")
		.replace(/\s+/g, " ").trim();
	const specific = role.length >= 3 ? role : profile.role;
	return [...new Set([`Junior ${specific}`, `${specific} I`, `Junior ${profile.role}`])];
}

export function sameTechnicalFunction(personTitle: string, jobTitle: string): boolean {
	const requested = technicalRoleProfile(jobTitle), actual = technicalRoleProfile(personTitle);
	if (!requested || !actual) return false;
	if (requested.label === "General Engineering") return actual.label === "General Engineering";
	return requested.pattern.test(personTitle);
}
