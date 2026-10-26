'use strict';

const API = {
  scoreboard: (dates) =>
    '/api/espn/site/apis/site/v2/sports/basketball/nba/scoreboard' + (dates ? '?dates=' + dates : ''),
  summary: (eventId) => '/api/espn/site/apis/site/v2/sports/basketball/nba/summary?event=' + eventId,
  search: (query) =>
    '/api/espn/site/apis/common/v3/search?query=' +
    encodeURIComponent(query) +
    '&type=player&sport=basketball&league=nba',
};

const STORE_KEY = 'nba-stand-v1';
const AUTH_TOKEN_KEY = 'nba-stand-auth-token';
const CLOUD_SYNC_DEBOUNCE_MS = 800;
const HOT_ALERT_KEY = 'nba-stand-hot-alerts-v1';
const VIEW_KEY = 'nba-stand-view-v1';
const REFRESH_SECONDS = 10;
// 技术统计拉取：移动端同一域名连接数有限，一次性并发十几场会排队超时
const SUMMARY_POOL_SIZE = 3;
const SUMMARY_MAX_ATTEMPTS = 3;
// 比赛 id -> 连续失败次数，用于失败重试与「暂不可用」提示
const summaryFailCounts = new Map();
// 用户主动点刷新时置位，让下一次请求带 X-Force-Refresh 穿透服务端缓存
let bypassCacheOnce = false;
// 首屏快照：存渲染结果而非原始 summary（12 场约 6MB，超出 localStorage 配额）
const SNAPSHOT_KEY = 'nba-stand-snapshot-v2';
const SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// 已载入内存的快照；渲染时若还没拿到实时数据就用它兜底
let snapshotPayload = null;
const HALFTIME_MS = 15.5 * 60 * 1000;
const QUARTER_BREAK_MS = 170 * 1000;
const BREAK_SAMPLE_MIN_MS = 90 * 1000;
const BREAK_SAMPLE_MAX_MS = 8 * 60 * 1000;
const TIMEOUT_VISIBLE_MS = 2 * 60 * 1000;
const HOT_MIN_MINUTES = 10;
const HOT_MIN_RULES = 2;
// 判定规则版本：门槛口径一改就递增，让赛季统计的旧缓存自动作废
const HOT_RULES_VERSION = 5; // 5：缓存增加逐场明细（log）；4：得分门槛 20→15 + 效率否决

const HOT_RULES = [
  { key: 'pts', label: '15+分', test: (stats) => stats.pts >= 15 },
  { key: 'reb', label: '8+板', test: (stats) => stats.reb >= 8 },
  { key: 'ast', label: '6+助', test: (stats) => stats.ast >= 6 },
  { key: 'stocks', label: '3+断帽', test: (stats) => stats.stl + stats.blk >= 3 },
  {
    key: 'ts',
    label: 'TS 60%+',
    test: (stats) => stats.fga >= 8 && stats.ts != null && stats.ts >= 60,
  },
  {
    key: 'pm',
    label: '正负+10',
    test: (stats) => stats.plusMinus != null && stats.plusMinus >= 10,
  },
];

// 一票否决：出手不少却几乎没产出，这种场次防守数据再好看也不该算「打得好」。
// 典型反例：22 分钟 7 投 0 中得 0 分、抢 8 个板，按纯达标项会被算成好球。
const HOT_DQ_MIN_ATTEMPTS = 5; // 出手次数达到该值才进入否决判断
const HOT_DQ_MIN_TS = 40; // 真实命中率低于该值视为进攻熄火
const HOT_DQ_MIN_POINTS = 5; // 得分低于该值同样视为熄火

const HOT_CRITERIA_TEXT =
  `上场至少 ${HOT_MIN_MINUTES} 分钟，满足任意 ${HOT_MIN_RULES} 项即算打得好：15+分、8+篮板、6+助攻、` +
  '3+抢断盖帽、真实命中率≥60%（至少8次出手）、正负值≥+10、两双/三双。' +
  `\n否决条件：出手 ≥${HOT_DQ_MIN_ATTEMPTS} 次且真实命中率 <${HOT_DQ_MIN_TS}%，或出手 ≥${HOT_DQ_MIN_ATTEMPTS} 次且得分 <${HOT_DQ_MIN_POINTS}，一律不算。`;

// 赛季逐场统计的口径说明：正负值要额外补查，见 parseGamelog
const HOT_SEASON_NOTE =
  '赛季场次按同一套门槛逐场统计（含效率否决条件），正负值取自逐场技术统计，仅对差一项达标的场次补查。';

// 第一遍打分用的规则集：先不判正负值，等补查结果回来再定论
const HOT_RULES_SEASON = HOT_RULES.filter((rule) => rule.key !== 'pm');

const CN_TEAMS = {
  ATL: '老鹰', BKN: '篮网', BOS: '凯尔特人', CHA: '黄蜂', CHI: '公牛', CLE: '骑士',
  DAL: '独行侠', DEN: '掘金', DET: '活塞', GS: '勇士', GSW: '勇士', HOU: '火箭',
  IND: '步行者', LAC: '快船', LAL: '湖人', MEM: '灰熊', MIA: '热火', MIL: '雄鹿',
  MIN: '森林狼', NO: '鹈鹕', NOP: '鹈鹕', NY: '尼克斯', NYK: '尼克斯', OKC: '雷霆',
  ORL: '魔术', PHI: '76人', PHX: '太阳', PHO: '太阳', POR: '开拓者', SAC: '国王',
  SA: '马刺', SAS: '马刺', TOR: '猛龙', UTAH: '爵士', UTA: '爵士', WSH: '奇才', WAS: '奇才',
};

const CN_POSITIONS = {
  G: '后卫', F: '前锋', C: '中锋',
  'G-F': '后卫/前锋', 'F-G': '前锋/后卫', 'F-C': '前锋/中锋', 'C-F': '中锋/前锋',
};

const REASON_CN = {
  "COACH'S DECISION": '教练决定',
  INJURY: '伤病',
  INJURED: '伤病',
  PERSONAL: '个人原因',
  SUSPENSION: '禁赛',
  'NOT WITH TEAM': '未随队',
  REST: '轮休',
  'HEALTH AND SAFETY PROTOCOLS': '健康安全协议',
};

const STORE_VERSION = 2;

const SEED_PLAYERS = [
  { id: '4432848', name: 'Jaime Jaquez Jr.', cn: '哈克斯', pos: 'F', teamId: '15', teamAbbr: 'MIL', headshot: '' },
  { id: '4702382', name: 'Tristan da Silva', cn: 'T·达席尔瓦', pos: 'F', teamId: '19', teamAbbr: 'ORL', headshot: '' },
  { id: '4711294', name: 'Matas Buzelis', cn: '布泽利斯', pos: 'F', teamId: '4', teamAbbr: 'CHI', headshot: '' },
  { id: '4433627', name: 'Keyonte George', cn: '乔治', pos: 'G', teamId: '26', teamAbbr: 'UTAH', headshot: '' },
  { id: '4683688', name: 'Dereck Lively II', cn: '莱夫利', pos: 'C', teamId: '6', teamAbbr: 'DAL', headshot: '' },
  { id: '5061589', name: 'Yves Missi', cn: '米西', pos: 'C', teamId: '3', teamAbbr: 'NO', headshot: '' },
  { id: '4683771', name: 'Ronald Holland II', cn: '霍兰德', pos: 'F', teamId: '8', teamAbbr: 'DET', headshot: '' },
  { id: '4683747', name: 'Jaylon Tyson', cn: '泰森', pos: 'G', teamId: '5', teamAbbr: 'CLE', headshot: '' },
  { id: '4869780', name: 'Derik Queen', cn: '奎恩', pos: 'C', teamId: '3', teamAbbr: 'NO', headshot: '' },
  { id: '4395630', name: 'Devin Vassell', cn: '瓦塞尔', pos: 'G', teamId: '24', teamAbbr: 'SA', headshot: '' },
  { id: '4888725', name: 'Ryan Dunn', cn: '邓恩', pos: 'F', teamId: '21', teamAbbr: 'PHX', headshot: '' },
  { id: '5242496', name: 'Noa Essengue', cn: '埃森格', pos: 'F', teamId: '4', teamAbbr: 'CHI', headshot: '' },
  { id: '5279133', name: 'Joan Beringer', cn: '贝林格', pos: 'F', teamId: '16', teamAbbr: 'MIN', headshot: '' },
  { id: '5214640', name: 'Kasparas Jakucionis', cn: '雅库乔尼斯', pos: 'G', teamId: '15', teamAbbr: 'MIL', headshot: '' },
  { id: '4277813', name: 'Herbert Jones', cn: '赫伯特·琼斯', pos: 'F', teamId: '3', teamAbbr: 'NO', headshot: '' },
  { id: '5211175', name: 'Zaccharie Risacher', cn: '里萨谢', pos: 'F', teamId: '6', teamAbbr: 'DAL', headshot: '' },
  { id: '5211176', name: 'Tidjane Salaun', cn: '萨隆', pos: 'F', teamId: '30', teamAbbr: 'CHA', headshot: '' },
  { id: '5105806', name: 'Jett Howard', cn: '杰特·霍华德', pos: 'G', teamId: '6', teamAbbr: 'DAL', headshot: '' },
  { id: '5106060', name: 'Jarace Walker', cn: '贾雷斯·沃克', pos: 'F', teamId: '11', teamAbbr: 'IND', headshot: '' },
  { id: '4593841', name: 'Baylor Scheierman', cn: '沙伊尔曼', pos: 'G', teamId: '2', teamAbbr: 'BOS', headshot: '' },
  { id: '4683750', name: 'Jordan Hawkins', cn: '霍金斯', pos: 'G', teamId: '4', teamAbbr: 'CHI', headshot: '' },
  { id: '4683686', name: 'Nick Smith Jr.', cn: '尼克·史密斯', pos: 'G', teamId: '13', teamAbbr: 'LAL', headshot: '' },
  { id: '4684275', name: 'Rob Dillingham', cn: '迪林厄姆', pos: 'G', teamId: '30', teamAbbr: 'CHA', headshot: '' },
  { id: '4712896', name: 'Noah Clowney', cn: '克洛尼', pos: 'F', teamId: '17', teamAbbr: 'BKN', headshot: '' },
  { id: '4433607', name: 'DaRon Holmes II', cn: '霍姆斯二世', pos: 'F', teamId: '7', teamAbbr: 'DEN', headshot: '' },
  { id: '4066354', name: 'Payton Pritchard', cn: '普里查德', pos: 'G', teamId: '2', teamAbbr: 'BOS', headshot: '' },
  { id: '4278076', name: 'Nick Richards', cn: '理查兹', pos: 'C', teamId: '14', teamAbbr: 'MIA', headshot: '' },
  { id: '5159925', name: 'Nikola Topic', cn: '托皮奇', pos: 'G', teamId: '25', teamAbbr: 'OKC', headshot: '' },
  { id: '4433188', name: 'Devin Carter', cn: '德文·卡特', pos: 'G', teamId: '2', teamAbbr: 'BOS', headshot: '' },
  { id: '4903027', name: 'Cedric Coward', cn: '考沃德', pos: 'F', teamId: '29', teamAbbr: 'MEM', headshot: '' },
  { id: '4845374', name: 'Bub Carrington', cn: '卡林顿', pos: 'G', teamId: '27', teamAbbr: 'WSH', headshot: '' },
  { id: '4896372', name: 'Walter Clayton Jr.', cn: '克莱顿', pos: 'G', teamId: '6', teamAbbr: 'DAL', headshot: '' },
  { id: '4684272', name: "Ja'Kobe Walter", cn: '贾科比·沃尔特', pos: 'G', teamId: '28', teamAbbr: 'TOR', headshot: '' },
  { id: '4432194', name: "Day'Ron Sharpe", cn: '夏普', pos: 'C', teamId: '17', teamAbbr: 'BKN', headshot: '' },
  { id: '4683692', name: 'Cason Wallace', cn: '华莱士', pos: 'G', teamId: '25', teamAbbr: 'OKC', headshot: '' },
  { id: '4683766', name: 'Isaiah Collier', cn: '科利尔', pos: 'G', teamId: '26', teamAbbr: 'UTAH', headshot: '' },
  { id: '4278067', name: 'Nic Claxton', cn: '克拉克斯顿', pos: 'C', teamId: '4', teamAbbr: 'CHI', headshot: '' },
  { id: '4997526', name: 'Ousmane Dieng', cn: '吉昂', pos: 'F', teamId: '15', teamAbbr: 'MIL', headshot: '' },
  { id: '4592492', name: 'Bones Hyland', cn: '海兰德', pos: 'G', teamId: '16', teamAbbr: 'MIN', headshot: '' },
  { id: '4433137', name: 'Ziaire Williams', cn: '齐亚伊尔·威廉姆斯', pos: 'F', teamId: '13', teamAbbr: 'LAL', headshot: '' },
  { id: '4895758', name: 'Cody Williams', cn: '科迪·威廉姆斯', pos: 'F', teamId: '16', teamAbbr: 'MIN', headshot: '' },
  { id: '4278039', name: 'Nickeil Alexander-Walker', cn: '亚历山大-沃克', pos: 'G', teamId: '1', teamAbbr: 'ATL', headshot: '' },
  { id: '5061603', name: 'Thomas Sorber', cn: '索伯', pos: 'C', teamId: '25', teamAbbr: 'OKC', headshot: '' },
  { id: '4684806', name: 'Taylor Hendricks', cn: '亨德里克斯', pos: 'F', teamId: '29', teamAbbr: 'MEM', headshot: '' },
  { id: '4566434', name: 'Franz Wagner', cn: '瓦格纳', pos: 'F', teamId: '19', teamAbbr: 'ORL', headshot: '' },
  { id: '4395724', name: 'Immanuel Quickley', cn: '奎克利', pos: 'G', teamId: '28', teamAbbr: 'TOR', headshot: '' },
  { id: '3149673', name: 'Pascal Siakam', cn: '西亚卡姆', pos: 'F', teamId: '11', teamAbbr: 'IND', headshot: '' },
];

/**
 * 用户 2026-10-22 提供的收藏名单（手游「球员交易 · 收藏」共 64 人）。
 * 只在首次加载时并入一次，之后不再重复（避免用户手动移除后被复活）。
 * id / 队伍 / 位置取自 ESPN 搜索接口，头像按 id 自动拼 ESPN 图源。
 */
const IMPORT_ONCE_KEY = 'nba-stand-import-20261022';
const IMPORT_PLAYERS = [
  { id: '4845367', name: 'Stephon Castle', cn: '斯蒂芬·卡斯尔', pos: 'G', teamId: '24', teamAbbr: 'SA' },
  { id: '4433287', name: 'Brandon Miller', cn: '布兰登·米勒', pos: 'F', teamId: '30', teamAbbr: 'CHA' },
  { id: '4593803', name: 'Jalen Williams', cn: '贾伦·威廉姆斯', pos: 'G', teamId: '25', teamAbbr: 'OKC' },
  { id: '5093267', name: 'Collin Murray-Boyles', cn: '科林·穆雷-博伊尔斯', pos: 'F', teamId: '28', teamAbbr: 'TOR' },
  { id: '5061568', name: 'Carter Bryant', cn: '卡特·布莱恩特', pos: 'F', teamId: '24', teamAbbr: 'SA' },
  { id: '4873138', name: 'Ace Bailey', cn: '埃斯·贝利', pos: 'G', teamId: '26', teamAbbr: 'UTAH' },
  { id: '5203685', name: 'Khaman Maluach', cn: '卡曼·马鲁阿奇', pos: 'C', teamId: '21', teamAbbr: 'PHX' },
  { id: '4683692', name: 'Cason Wallace', cn: '凯森·华莱士', pos: 'G', teamId: '25', teamAbbr: 'OKC' },
  { id: '4903027', name: 'Cedric Coward', cn: '塞德里克·考沃德', pos: 'F', teamId: '29', teamAbbr: 'MEM' },
  { id: '4432165', name: 'Jalen Suggs', cn: '杰伦·萨格斯', pos: 'G', teamId: '19', teamAbbr: 'ORL' },
  { id: '5144091', name: 'Jeremiah Fears', cn: '杰雷米亚·费尔斯', pos: 'G', teamId: '3', teamAbbr: 'NO' },
  { id: '5175643', name: 'Egor Demin', cn: '叶戈尔·杰明', pos: 'G', teamId: '17', teamAbbr: 'BKN' },
  { id: '4898371', name: 'Maxime Raynaud', cn: '马克西姆·雷诺', pos: 'C', teamId: '23', teamAbbr: 'SAC' },
  { id: '3149673', name: 'Pascal Siakam', cn: '帕斯卡尔·西亚卡姆', pos: 'F', teamId: '11', teamAbbr: 'IND' },
  { id: '4712849', name: 'Anthony Black', cn: '安东尼·布莱克', pos: 'G', teamId: '19', teamAbbr: 'ORL' },
  { id: '5211175', name: 'Zaccharie Risacher', cn: '扎卡里·里萨谢', pos: 'F', teamId: '6', teamAbbr: 'DAL' },
  { id: '5112087', name: 'Jaylen Wells', cn: '杰伦·威尔斯', pos: 'F', teamId: '29', teamAbbr: 'MEM' },
  { id: '4888725', name: 'Ryan Dunn', cn: '瑞安·邓恩', pos: 'F', teamId: '21', teamAbbr: 'PHX' },
  { id: '5211176', name: 'Tidjane Salaun', cn: '提贾尼·萨隆', pos: 'F', teamId: '30', teamAbbr: 'CHA' },
  { id: '4683771', name: 'Ronald Holland II', cn: '罗恩·霍兰德', pos: 'F', teamId: '8', teamAbbr: 'DET' },
  { id: '5061589', name: 'Yves Missi', cn: '伊夫·米西', pos: 'C', teamId: '3', teamAbbr: 'NO' },
  { id: '4683688', name: 'Dereck Lively II', cn: '德雷克·莱夫利', pos: 'C', teamId: '6', teamAbbr: 'DAL' },
  { id: '4871145', name: 'Josh Giddey', cn: '约什·吉迪', pos: 'G', teamId: '4', teamAbbr: 'CHI' },
  { id: '5106060', name: 'Jarace Walker', cn: '贾雷斯·沃克', pos: 'F', teamId: '11', teamAbbr: 'IND' },
  { id: '4277813', name: 'Herbert Jones', cn: '赫伯特·琼斯', pos: 'F', teamId: '3', teamAbbr: 'NO' },
  { id: '4869780', name: 'Derik Queen', cn: '德里克·奎恩', pos: 'C', teamId: '3', teamAbbr: 'NO' },
  { id: '4433247', name: 'Jonathan Kuminga', cn: '乔纳森·库明加', pos: 'F', teamId: '16', teamAbbr: 'MIN' },
  { id: '5214640', name: 'Kasparas Jakucionis', cn: '卡斯帕拉斯·雅库乔尼斯', pos: 'G', teamId: '15', teamAbbr: 'MIL' },
  { id: '4433137', name: 'Ziaire Williams', cn: '齐亚伊尔·威廉姆斯', pos: 'F', teamId: '13', teamAbbr: 'LAL' },
  { id: '5242496', name: 'Noa Essengue', cn: '诺亚·埃森格', pos: 'F', teamId: '4', teamAbbr: 'CHI' },
  { id: '4601025', name: 'Pelle Larsson', cn: '佩莱·拉尔森', pos: 'G', teamId: '14', teamAbbr: 'MIA' },
  { id: '4684806', name: 'Taylor Hendricks', cn: '泰勒·亨德里克斯', pos: 'F', teamId: '29', teamAbbr: 'MEM' },
  { id: '4395712', name: 'Andrew Nembhard', cn: '安德鲁·内姆哈德', pos: 'G', teamId: '11', teamAbbr: 'IND' },
  { id: '4066320', name: 'Desmond Bane', cn: '德斯蒙德·贝恩', pos: 'G', teamId: '19', teamAbbr: 'ORL' },
  { id: '4395630', name: 'Devin Vassell', cn: '德文·瓦塞尔', pos: 'G', teamId: '24', teamAbbr: 'SA' },
  { id: '4683747', name: 'Jaylon Tyson', cn: '杰隆·泰森', pos: 'G', teamId: '5', teamAbbr: 'CLE' },
  { id: '4432194', name: "Day'Ron Sharpe", cn: '戴罗恩·夏普', pos: 'C', teamId: '17', teamAbbr: 'BKN' },
  { id: '4702384', name: 'Nique Clifford', cn: '尼克·克里福德', pos: 'G', teamId: '23', teamAbbr: 'SAC' },
  { id: '5061603', name: 'Thomas Sorber', cn: '托马斯·索伯', pos: 'C', teamId: '25', teamAbbr: 'OKC' },
  { id: '4895758', name: 'Cody Williams', cn: '科迪·威廉姆斯', pos: 'F', teamId: '16', teamAbbr: 'MIN' },
  { id: '4997526', name: 'Ousmane Dieng', cn: '奥斯曼·吉昂', pos: 'F', teamId: '15', teamAbbr: 'MIL' },
  { id: '4432848', name: 'Jaime Jaquez Jr.', cn: '小海梅·哈克斯', pos: 'F', teamId: '15', teamAbbr: 'MIL' },
  { id: '4396909', name: 'Aaron Nesmith', cn: '阿龙·内史密斯', pos: 'G', teamId: '11', teamAbbr: 'IND' },
  { id: '4278076', name: 'Nick Richards', cn: '尼克·理查兹', pos: 'C', teamId: '14', teamAbbr: 'MIA' },
  { id: '4683766', name: 'Isaiah Collier', cn: '以赛亚·科利尔', pos: 'G', teamId: '26', teamAbbr: 'UTAH' },
  { id: '4278053', name: 'Davion Mitchell', cn: '达维昂·米切尔', pos: 'G', teamId: '14', teamAbbr: 'MIA' },
  { id: '4278078', name: 'P.J. Washington', cn: 'P.J. 华盛顿', pos: 'F', teamId: '6', teamAbbr: 'DAL' },
  { id: '4433083', name: 'Cam Spencer', cn: '卡姆·斯潘塞', pos: 'G', teamId: '29', teamAbbr: 'MEM' },
  { id: '4702382', name: 'Tristan da Silva', cn: '特里斯坦·达席尔瓦', pos: 'F', teamId: '19', teamAbbr: 'ORL' },
  { id: '4684272', name: "Ja'Kobe Walter", cn: '贾科比·沃尔特', pos: 'G', teamId: '28', teamAbbr: 'TOR' },
  { id: '4896372', name: 'Walter Clayton Jr.', cn: '沃尔特·克莱顿', pos: 'G', teamId: '6', teamAbbr: 'DAL' },
  { id: '4712896', name: 'Noah Clowney', cn: '诺厄·克洛尼', pos: 'F', teamId: '17', teamAbbr: 'BKN' },
  { id: '4997528', name: 'Nikola Jovic', cn: '尼古拉·约维奇', pos: 'F', teamId: '14', teamAbbr: 'MIA' },
  { id: '4433188', name: 'Devin Carter', cn: '德文·卡特', pos: 'G', teamId: '2', teamAbbr: 'BOS' },
  { id: '5159925', name: 'Nikola Topic', cn: '尼古拉·托皮奇', pos: 'G', teamId: '25', teamAbbr: 'OKC' },
  { id: '4684275', name: 'Rob Dillingham', cn: '罗伯特·迪林厄姆', pos: 'G', teamId: '30', teamAbbr: 'CHA' },
  { id: '4845374', name: 'Bub Carrington', cn: '卡尔顿·卡林顿', pos: 'G', teamId: '27', teamAbbr: 'WSH' },
  { id: '4683686', name: 'Nick Smith Jr.', cn: '小尼克·史密斯', pos: 'G', teamId: '13', teamAbbr: 'LAL' },
  { id: '4065733', name: 'Ty Jerome', cn: '泰·杰罗姆', pos: 'G', teamId: '29', teamAbbr: 'MEM' },
  { id: '4432170', name: 'Isaiah Jackson', cn: '以赛亚·杰克逊', pos: 'F', teamId: '12', teamAbbr: 'LAC' },
  { id: '4683750', name: 'Jordan Hawkins', cn: '乔丹·霍金斯', pos: 'G', teamId: '4', teamAbbr: 'CHI' },
  { id: '5105806', name: 'Jett Howard', cn: '杰特·霍华德', pos: 'G', teamId: '6', teamAbbr: 'DAL' },
  { id: '5211983', name: 'Pacome Dadiet', cn: '帕科姆·达迪耶', pos: 'F', teamId: '18', teamAbbr: 'NY' },
  { id: '4433607', name: 'DaRon Holmes II', cn: '达隆·霍姆斯', pos: 'F', teamId: '7', teamAbbr: 'DEN' },
];

/**
 * 用户 2026-10-22 提供的「我的背包」球员（出售页球员列表，共 28 人）。
 * 与收藏组区分：已关注的打上 group='bag' 标记，未关注的直接加入。
 * 只在首次加载时执行一次。
 */
const BAG_IMPORT_KEY = 'nba-stand-bag-20261022';
const BAG_PLAYERS = [
  { id: '5105565', name: 'Donovan Clingan', cn: '多诺万·克林根', pos: 'C', teamId: '22', teamAbbr: 'POR' },
  { id: '4433136', name: 'Walker Kessler', cn: '沃克·科斯勒', pos: 'C', teamId: '13', teamAbbr: 'LAL' },
  { id: '4431680', name: 'Onyeka Okongwu', cn: '奥涅卡·奥孔古', pos: 'F', teamId: '1', teamAbbr: 'ATL' },
  { id: '4576087', name: 'Peyton Watson', cn: '佩顿·沃特森', pos: 'G', teamId: '5', teamAbbr: 'CLE' },
  { id: '4683021', name: 'Deni Avdija', cn: '德尼·阿夫迪亚', pos: 'F', teamId: '22', teamAbbr: 'POR' },
  { id: '4397688', name: 'Trey Murphy III', cn: '特雷·墨菲', pos: 'F', teamId: '3', teamAbbr: 'NO' },
  { id: '4431736', name: 'Toumani Camara', cn: '图马尼·卡马拉', pos: 'F', teamId: '22', teamAbbr: 'POR' },
  { id: '5238230', name: 'Tre Johnson', cn: '特雷·约翰逊', pos: 'G', teamId: '27', teamAbbr: 'WSH' },
  { id: '5104155', name: 'Bilal Coulibaly', cn: '比拉尔·库利巴利', pos: 'G', teamId: '27', teamAbbr: 'WSH' },
  { id: '5174563', name: 'Kyshawn George', cn: '凯肖恩·乔治', pos: 'F', teamId: '27', teamAbbr: 'WSH' },
  { id: '4395725', name: 'Tyler Herro', cn: '泰勒·希罗', pos: 'G', teamId: '15', teamAbbr: 'MIL' },
  { id: '4395628', name: 'Zion Williamson', cn: '锡安·威廉姆斯', pos: 'F', teamId: '3', teamAbbr: 'NO' },
  { id: '5279130', name: 'Nolan Traore', cn: '诺兰·特劳雷', pos: 'G', teamId: '17', teamAbbr: 'BKN' },
  { id: '4397140', name: 'Kevin Porter Jr.', cn: '小凯文·波特', pos: 'G', teamId: '15', teamAbbr: 'MIL' },
  { id: '4595400', name: 'Olivier-Maxence Prosper', cn: '奥利维耶·普罗斯珀', pos: 'F', teamId: '29', teamAbbr: 'MEM' },
  { id: '4397014', name: 'Quentin Grimes', cn: '昆廷·格兰姆斯', pos: 'G', teamId: '13', teamAbbr: 'LAL' },
  { id: '4433076', name: 'Ben Sheppard', cn: '本·谢泼德', pos: 'G', teamId: '11', teamAbbr: 'IND' },
  { id: '5105839', name: 'Brice Sensabaugh', cn: '布赖斯·森萨博', pos: 'F', teamId: '26', teamAbbr: 'UTAH' },
  { id: '4711294', name: 'Matas Buzelis', cn: '马塔斯·布泽利斯', pos: 'F', teamId: '4', teamAbbr: 'CHI' },
  { id: '4566434', name: 'Franz Wagner', cn: '弗朗茨·瓦格纳', pos: 'F', teamId: '19', teamAbbr: 'ORL' },
  { id: '4433627', name: 'Keyonte George', cn: '基昂特·乔治', pos: 'G', teamId: '26', teamAbbr: 'UTAH' },
  { id: '5279133', name: 'Joan Beringer', cn: '琼·贝林格', pos: 'F', teamId: '16', teamAbbr: 'MIN' },
  { id: '4278039', name: 'Nickeil Alexander-Walker', cn: '尼基尔·亚历山大-沃克', pos: 'G', teamId: '1', teamAbbr: 'ATL' },
  { id: '4278067', name: 'Nic Claxton', cn: '尼克拉克斯顿', pos: 'C', teamId: '4', teamAbbr: 'CHI' },
  { id: '4066354', name: 'Payton Pritchard', cn: '佩顿·普里查德', pos: 'G', teamId: '2', teamAbbr: 'BOS' },
  { id: '4395724', name: 'Immanuel Quickley', cn: '伊曼纽尔·奎克利', pos: 'G', teamId: '28', teamAbbr: 'TOR' },
  { id: '4593841', name: 'Baylor Scheierman', cn: '贝恩·沙伊尔曼', pos: 'G', teamId: '2', teamAbbr: 'BOS' },
  { id: '4684272', name: "Ja'Kobe Walter", cn: '贾科比·沃尔特', pos: 'G', teamId: '28', teamAbbr: 'TOR' },
];

/* ---------- 打得好的稳定性统计 ---------- */

const HOT_STATS_KEY = 'nba-stand-hot-stats-v1';
const HOT_THRESHOLD_KEY = 'nba-stand-hot-threshold-v1';
const DEFAULT_HOT_THRESHOLD = 5;
// 赛季火热场次缓存有效期。不能按「美东日期」判活：
// 美东同一天里可能先有比赛结束，日期没变但数据已经变了。
const HOT_STATS_TTL_MS = 60 * 60 * 1000;
const GAMELOG_API = (id, season) =>
  // 用 site 域名而不是 site.web：线上沙箱访问 site.web.api.espn.com 会 25 秒超时
  `/api/espn/site/apis/common/v3/sports/basketball/nba/athletes/${id}/gamelog` +
  (season ? `?season=${season}` : '');

const NAME_ZH = {
  // 老鹰
  'aaron wiggins': '阿隆·威金斯',
  'cj mccollum': 'CJ·麦科勒姆',
  'dyson daniels': '戴森·丹尼尔斯',
  'jalen johnson': '杰伦·约翰逊',
  'jock landale': '乔克·兰代尔',
  'kingston flemings': '金斯顿·弗莱明斯',
  'luguentz dort': '卢根茨·多尔特',
  'nickeil alexander-walker': '亚历山大-沃克',
  'onyeka okongwu': '奥涅卡·奥孔古',
  // 篮网
  'chaney johnson': '钱尼·约翰逊',
  'dayron sharpe': '夏普',
  'egor demin': '叶戈尔·杰明',
  'julius randle': '朱利叶斯·兰德尔',
  'keon ellis': '基恩·埃利斯',
  'michael porter': '小迈克尔·波特',
  'mikel brown': '小迈克尔·布朗',
  'moritz wagner': '莫里茨·瓦格纳',
  'noah clowney': '克洛尼',
  'nolan traore': '诺兰·特拉奥雷',
  // 黄蜂
  'brandon miller': '布兰登·米勒',
  'christian anderson': '克里斯蒂安·安德森',
  'dennis schroder': '丹尼斯·施罗德',
  'grayson allen': '格雷森·阿伦',
  'liam mcneeley': '利亚姆·麦克尼利',
  'moussa diabate': '穆萨·迪亚巴特',
  'naz reid': '纳兹·里德',
  'royce oneale': '罗伊斯·奥尼尔',
  'ryan kalkbrenner': '瑞安·卡尔克布伦纳',
  'sion james': '赛昂·詹姆斯',
  // 公牛
  'buddy hield': '巴迪·希尔德',
  'caleb wilson': '凯莱布·威尔逊',
  'isaac okoro': '艾萨克·奥科罗',
  'jalen smith': '杰伦·史密斯',
  'jaylin sellers': '杰林·塞勒斯',
  'josh giddey': '约什·吉迪',
  'leonard miller': '伦纳德·米勒',
  'matas buzelis': '布泽利斯',
  'noa essengue': '埃森格',
  'norman powell': '诺曼·鲍威尔',
  'tobe awaka': '托比·阿瓦卡',
  'tre jones': '特雷·琼斯',
  'zach collins': '扎克·科林斯',
  // 独行侠
  'cooper flagg': '库珀·弗拉格',
  'daniel gafford': '丹尼尔·加福德',
  'kyrie irving': '凯里·欧文',
  'marcus sasser': '马库斯·萨瑟',
  'max christie': '马克斯·克里斯蒂',
  'morez johnson': '小莫雷兹·约翰逊',
  'naji marshall': '纳吉·马歇尔',
  'pj washington': 'PJ·华盛顿',
  'sergio de larrea': '塞尔吉奥·德·拉雷亚',
  'zaccharie risacher': '里萨谢',
  // 勇士
  'deanthony melton': '德安东尼·梅尔顿',
  'draymond green': '德雷蒙德·格林',
  'gui santos': '桂·桑托斯',
  'stephen curry': '斯蒂芬·库里',
  'yaxel lendeborg': '亚克塞尔·伦德伯格',
  // 火箭
  'alperen sengun': '阿尔佩伦·申京',
  'amen thompson': '阿门·汤普森',
  'bogdan bogdanovic': '博格丹·博格达诺维奇',
  'clint capela': '克林特·卡佩拉',
  'fred vanvleet': '弗雷德·范弗里特',
  'jabari smith': '小贾巴里·史密斯',
  'kevin durant': '凯文·杜兰特',
  'marcus smart': '马库斯·斯马特',
  'reed sheppard': '里德·谢泼德',
  'tari eason': '塔里·伊森',
  // 步行者
  'andrew nembhard': '安德鲁·内姆哈德',
  'ben sheppard': '本·谢泼德',
  'ivica zubac': '伊维察·祖巴茨',
  'jarace walker': '贾雷斯·沃克',
  'kelly oubre': '小凯利·乌布雷',
  'larry nance': '小拉里·南斯',
  'obi toppin': '奥比·托平',
  'pascal siakam': '西亚卡姆',
  'quenton jackson': '昆顿·杰克逊',
  'tyrese haliburton': '泰雷塞·哈利伯顿',
  // 湖人
  'austin reaves': '奥斯汀·里夫斯',
  'luka doncic': '卢卡·东契奇',
  'matisse thybulle': '马蒂斯·赛布尔',
  'walker kessler': '沃克·凯斯勒',
  'ziaire williams': '齐亚伊尔·威廉姆斯',
  // 灰熊
  'cam spencer': '卡姆·斯宾塞',
  'cameron boozer': '卡梅隆·布泽尔',
  'cedric coward': '考沃德',
  'gg jackson': 'GG·杰克逊',
  'jaylen wells': '杰伦·威尔斯',
  'jerami grant': '杰拉米·格兰特',
  'quinten post': '昆滕·波斯特',
  'scotty pippen': '小斯科蒂·皮蓬',
  'ty jerome': '泰·杰罗姆',
  'zach edey': '扎克·伊迪',
  // 热火
  'andrew wiggins': '安德鲁·威金斯',
  'bam adebayo': '巴姆·阿德巴约',
  'bobby portis': '博比·波蒂斯',
  'davion mitchell': '戴维恩·米切尔',
  'giannis antetokounmpo': '扬尼斯·阿德托昆博',
  'klay thompson': '克莱·汤普森',
  'myron gardner': '迈伦·加德纳',
  'nick richards': '理查兹',
  'nikola jovic': '尼古拉·约维奇',
  'pelle larsson': '佩勒·拉尔森',
  'ryan conwell': '瑞安·康威尔',
  'simone fontecchio': '西蒙内·丰泰基奥',
  'tim hardaway': '小蒂姆·哈达威',
  // 雄鹿
  'aj green': 'AJ·格林',
  'brayden burries': '布雷登·伯里斯',
  'jaime jaquez': '哈克斯',
  'jericho sims': '杰里科·西姆斯',
  'kasparas jakucionis': '雅库乔尼斯',
  'kelel ware': '凯尔·韦尔',
  'kyle kuzma': '凯尔·库兹马',
  'myles turner': '迈尔斯·特纳',
  'ousmane dieng': '吉昂',
  'ryan rollins': '瑞安·罗林斯',
  'tyler herro': '泰勒·希罗',
  // 森林狼
  'anthony edwards': '安东尼·爱德华兹',
  'ayo dosunmu': '阿约·多苏穆',
  'bones hyland': '海兰德',
  'cody williams': '科迪·威廉姆斯',
  'isaiah evans': '以赛亚·埃文斯',
  'jaden mcdaniels': '杰登·麦克丹尼尔斯',
  'jaylen clark': '杰伦·克拉克',
  'joan beringer': '贝林格',
  'jonathan kuminga': '乔纳森·库明加',
  'lamelo ball': '拉梅洛·鲍尔',
  'rudy gobert': '鲁迪·戈贝尔',
  'terrence shannon': '小特伦斯·香农',
  'trey lyles': '特雷·莱尔斯',
  // 鹈鹕
  'bennedict mathurin': '本内迪克特·马图林',
  'dejounte murray': '德章泰·穆雷',
  'derik queen': '奎恩',
  'herbert jones': '赫伯特·琼斯',
  'jeremiah fears': '杰里迈亚·费尔斯',
  'jordan poole': '乔丹·普尔',
  'saddiq bey': '萨迪克·贝',
  'trey murphy': '特雷·墨菲三世',
  'yves missi': '米西',
  'zion williamson': '锡安·威廉森',
  // 魔术
  'desmond bane': '德斯蒙德·贝恩',
  'franz wagner': '瓦格纳',
  'goga bitadze': '戈加·比塔泽',
  'jalen suggs': '杰伦·萨格斯',
  'jamal cain': '贾马尔·凯恩',
  'jase richardson': '杰斯·理查德森',
  'nikola vucevic': '尼古拉·武切维奇',
  'paolo banchero': '保罗·班凯罗',
  'tristan da silva': 'T·达席尔瓦',
  'wendell carter': '小温德尔·卡特',
  // 太阳
  'collin gillespie': '科林·吉莱斯皮',
  'devin booker': '德文·布克',
  'dillon brooks': '狄龙·布鲁克斯',
  'jalen green': '杰伦·格林',
  'khaman maluach': '卡曼·马卢阿奇',
  'miles bridges': '迈尔斯·布里奇斯',
  // 开拓者
  'damian lillard': '达米安·利拉德',
  'deni avdija': '德尼·阿夫迪亚',
  'donovan clingan': '多诺万·克林根',
  'ja morant': '贾·莫兰特',
  'toumani camara': '图马尼·卡马拉',
  // 猛龙
  'alijah martin': '阿利贾·马丁',
  'allen graves': '艾伦·格雷夫斯',
  'collin murray-boyles': '科林·默里-博伊尔斯',
  'immanuel quickley': '奎克利',
  'jakobe walter': '贾科比·沃尔特',
  'jaden bradley': '杰登·布拉德利',
  'jakob poeltl': '雅各布·珀尔特尔',
  'jamal shead': '贾马尔·谢德',
  'jamison battle': '贾米森·巴特尔',
  'kawhi leonard': '科怀·伦纳德',
  'kyle anderson': '凯尔·安德森',
  'rj barrett': 'RJ·巴雷特',
  'scottie barnes': '斯科蒂·巴恩斯',
  'trayce jackson-davis': '特雷斯·杰克逊-戴维斯',
  // 爵士
  'ace bailey': '埃斯·贝利',
  'brice sensabaugh': '布里斯·森萨博',
  'darryn peterson': '达林·彼得森',
  'isaiah collier': '科利尔',
  'jaren jackson': '小贾伦·杰克逊',
  'jaxson hayes': '贾克森·海斯',
  'josh okogie': '约什·奥科吉',
  'keyonte george': '乔治',
  'kyle filipowski': '凯尔·菲利波夫斯基',
  'lauri markkanen': '劳里·马尔卡宁',
  'svi mykhailiuk': '斯维·米哈伊柳克',
  // 奇才
  'alex sarr': '亚历克斯·萨尔',
  'anthony davis': '安东尼·戴维斯',
  'bilal coulibaly': '比拉尔·库利巴利',
  'bub carrington': '卡林顿',
  'deandre ayton': '德安德烈·艾顿',
  'justin champagnie': '贾斯汀·尚帕尼',
  'khris middleton': '克里斯·米德尔顿',
  'kyshawn george': '基肖恩·乔治',
  'trae young': '特雷·杨',
  'tre johnson': '特雷·约翰逊',
  // 轮换补录
  'georges niang': '乔治斯·尼昂',
  'al horford': '阿尔·霍福德',
  'gary payton': '加里·佩顿二世',
  'brandon williams': '布兰登·威廉姆斯',
  'kevon looney': '凯文·卢尼',
  'sandro mamukelashvili': '桑德罗·马穆克拉什维利',
  'quentin grimes': '昆汀·格莱姆斯',
  'oso ighodaro': '奥索·伊戈达罗',
  'jordan goodwin': '乔丹·古德温',
  'robert williams': '罗伯特·威廉姆斯',
  'jake laravia': '杰克·拉拉维亚',
  'jrue holiday': '朱·霍勒迪',
  'scoot henderson': '斯库特·亨德森',
  'sidy cissoko': '西迪·西索科',
  // 常见球星（搜索用）
  'lebron james': '勒布朗·詹姆斯',
  'jayson tatum': '杰森·塔图姆',
  'jaylen brown': '杰伦·布朗',
  'donovan mitchell': '多诺万·米切尔',
  'jalen brunson': '杰伦·布伦森',
  'karl-anthony towns': '卡尔-安东尼·唐斯',
  'joel embiid': '乔尔·恩比德',
  'tyrese maxey': '泰雷塞·马克西',
  'jimmy butler': '吉米·巴特勒',
  'nikola jokic': '尼古拉·约基奇',
  'jamal murray': '贾马尔·穆雷',
  'aaron gordon': '阿隆·戈登',
  'victor wembanyama': '维克托·文班亚马',
  'chet holmgren': '切特·霍姆格伦',
  'shai gilgeous-alexander': '谢伊·吉尔杰斯-亚历山大',
  'jalen williams': '杰伦·威廉姆斯',
  'evan mobley': '埃文·莫布利',
  'jarrett allen': '贾勒特·阿伦',
  'darius garland': '达里厄斯·加兰',
  'cade cunningham': '凯德·坎宁安',
  'deaaron fox': '达龙·福克斯',
  'domantas sabonis': '多曼塔斯·萨博尼斯',
  'mikal bridges': '米卡尔·布里奇斯',
  'og anunoby': 'OG·阿努诺比',
  'josh hart': '约什·哈特',
  'coby white': '科比·怀特',
  'zach lavine': '扎克·拉文',
  'demar derozan': '德马尔·德罗赞',
  'jonas valanciunas': '约纳斯·瓦兰丘纳斯',
  'mark williams': '马克·威廉姆斯',
  'jalen duren': '杰伦·杜伦',
  'ausar thompson': '奥萨尔·汤普森',
  'donte divincenzo': '唐特·迪文琴佐',
};

for (const player of SEED_PLAYERS) {
  const key = normalizePlayerName(player.name);
  if (key && player.cn && !NAME_ZH[key]) NAME_ZH[key] = player.cn;
}

const NAME_ZH_PARTS = { first: Object.create(null), last: Object.create(null) };
for (const [key, zh] of Object.entries(NAME_ZH)) {
  const tokens = key.split(' ');
  const parts = zh.split('·');
  if (tokens.length !== 2 || parts.length !== 2 || !parts[0] || !parts[1] || zh.startsWith('小')) continue;
  if (!NAME_ZH_PARTS.first[tokens[0]]) NAME_ZH_PARTS.first[tokens[0]] = parts[0];
  if (!NAME_ZH_PARTS.last[tokens[1]]) NAME_ZH_PARTS.last[tokens[1]] = parts[1];
}

/* ---------- 中文名反查索引（添加球员支持中文搜索） ---------- */

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

// 归一化：去空格、间隔号、标点，转小写——"斯蒂芬·库里" 与 "斯蒂芬库里" 视为同一串
function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s·・.．,，'’"“”\-_—]+/g, '');
}

// 本地可直达的球员（关注种子 / 收藏导入 / 背包导入），自带 ESPN id，命中后无需请求接口
const CN_PLAYER_INDEX = Object.create(null);
for (const player of [...SEED_PLAYERS, ...IMPORT_PLAYERS, ...BAG_PLAYERS]) {
  const norm = normalizeSearchText(player.cn);
  if (norm && player.id && !CN_PLAYER_INDEX[norm]) CN_PLAYER_INDEX[norm] = player;
}

// NAME_ZH 反查：归一化中文名 -> 英文名（覆盖全联盟，用于接口补全本地没有的球员）
const ZH_NAME_TO_EN = Object.create(null);
for (const [en, zh] of Object.entries(NAME_ZH)) {
  const norm = normalizeSearchText(zh);
  if (norm && !ZH_NAME_TO_EN[norm]) ZH_NAME_TO_EN[norm] = en;
}

// 本地名单中文模糊命中（关注/背包/收藏导入 + 当前已关注）
function localCnMatches(query, limit = 12) {
  const q = normalizeSearchText(query);
  if (!q) return [];
  const hits = [];
  const seen = new Set();
  const consider = (player) => {
    const norm = normalizeSearchText(player.cn);
    if (!norm || !norm.includes(q) || !player.id || seen.has(String(player.id))) return;
    seen.add(String(player.id));
    hits.push(player);
  };
  for (const norm of Object.keys(CN_PLAYER_INDEX)) {
    if (norm.includes(q)) consider(CN_PLAYER_INDEX[norm]);
  }
  for (const player of state.players) consider(player);
  hits.sort((a, b) => {
    const na = normalizeSearchText(a.cn);
    const nb = normalizeSearchText(b.cn);
    return (na === q ? 0 : 1) - (nb === q ? 0 : 1) || na.length - nb.length;
  });
  return hits.slice(0, limit);
}

// 全联盟中文译名命中：返回 [{ norm, en }]，按完全匹配优先、译名长短排序
function cnNameToEnglishMatches(query, limit = 6) {
  const q = normalizeSearchText(query);
  if (!q) return [];
  const norms = Object.keys(ZH_NAME_TO_EN).filter((norm) => norm.includes(q));
  norms.sort((a, b) => (a === q ? 0 : 1) - (b === q ? 0 : 1) || a.length - b.length);
  return norms.slice(0, limit).map((norm) => ({ norm, en: ZH_NAME_TO_EN[norm] }));
}

// 本地球员记录转成 ESPN 搜索结果的 item 结构，复用同一套渲染/添加逻辑
function localPlayerToItem(player) {
  return {
    id: String(player.id),
    displayName: player.name,
    position: player.pos ? { abbreviation: player.pos } : null,
    headshot: player.headshot ? { href: player.headshot } : null,
    teamRelationships: player.teamId
      ? [{ type: 'team', core: { id: player.teamId, abbreviation: player.teamAbbr, displayName: player.teamAbbr } }]
      : [],
    _cn: player.cn || '',
  };
}

const SORTS = [
  ['points', '得分'],
  ['rebounds', '篮板'],
  ['assists', '助攻'],
  ['steals', '抢断'],
  ['blocks', '盖帽'],
  ['offRebounds', '前场篮板'],
  ['minutes', '出场时间'],
  ['efficiency', '效率值 EFF'],
  ['ts', '真实命中率 TS%'],
  ['efg', '有效命中率 eFG%'],
  ['usg', '使用率 USG%'],
  ['astPct', '助攻率 AST%'],
  ['rebPct', '篮板率 REB%'],
  ['plusMinus', '正负值 +/-'],
  ['hotGames', '赛季火热场次'],
  ['name', '姓名'],
];

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const state = {
  players: [],
  teams: new Map(),
  games: [],
  summaries: new Map(),
  dateParam: null,
  slateDate: null,
  view: 'players',
  filterStatus: 'all',
  filterTeam: 'all',
  gameFilter: 'all',
  sortKey: 'points',
  sortDir: 'desc',
  rows: [],
  gameMeta: new Map(),
  refreshing: false,
  pendingRefresh: false,
  hasData: false,
  loadError: null,
  lastUpdated: null,
  hotStats: {},
  hotThreshold: DEFAULT_HOT_THRESHOLD,
  hotStatsLoading: false,
  hotStatsLoaded: false,
  auth: { token: null, user: null, ready: false },
};

const el = {};

let secondsLeft = REFRESH_SECONDS;
let searchDebounce = null;
let searchSeq = 0;
let searchCache = [];
let searchComposing = false; // 中文输入法组词中，暂停搜索
let rosterModalGameId = null;
let rosterModalTrigger = null;
let toastTimer = null;
let teamOptionsSignature = '';
const halftimeSeen = new Map();
const endPeriodSeen = new Map();
const summaryTotalsCache = new WeakMap();
let hotAlertStore = loadHotAlertStore();

document.addEventListener('DOMContentLoaded', init);

async function init() {
  el.viewTabs = document.getElementById('viewTabs');
  el.playersView = document.getElementById('playersView');
  el.teamsView = document.getElementById('teamsView');
  el.teamSummary = document.getElementById('teamSummary');
  el.gameFilter = document.getElementById('gameFilter');
  el.teamGrid = document.getElementById('teamGrid');
  el.teamEmpty = document.getElementById('teamEmpty');
  el.teamUpdatedAt = document.getElementById('teamUpdatedAt');
  el.dateLabel = document.getElementById('dateLabel');
  el.dateHint = document.getElementById('dateHint');
  el.prevDate = document.getElementById('prevDate');
  el.nextDate = document.getElementById('nextDate');
  el.todayDate = document.getElementById('todayDate');
  el.refreshBtn = document.getElementById('refreshBtn');
  el.addPlayerBtn = document.getElementById('addPlayerBtn');
  el.exportBtn = document.getElementById('exportBtn');
  el.importBtn = document.getElementById('importBtn');
  el.importFile = document.getElementById('importFile');
  el.errorBanner = document.getElementById('errorBanner');
  el.errorText = document.getElementById('errorText');
  el.retryBtn = document.getElementById('retryBtn');
  el.summaryBar = document.getElementById('summaryBar');
  el.hotBar = document.getElementById('hotBar');
  el.statusFilter = document.getElementById('statusFilter');
  el.teamFilter = document.getElementById('teamFilter');
  el.sortSelect = document.getElementById('sortSelect');
  el.hotThreshold = document.getElementById('hotThreshold');
  el.sortDirBtn = document.getElementById('sortDirBtn');
  el.updatedAt = document.getElementById('updatedAt');
  el.grid = document.getElementById('grid');
  el.emptyState = document.getElementById('emptyState');
  el.modal = document.getElementById('modal');
  el.modalClose = document.getElementById('modalClose');
  el.playerSearch = document.getElementById('playerSearch');
  el.searchResults = document.getElementById('searchResults');
  el.rosterModal = document.getElementById('rosterModal');
  el.rosterModalClose = document.getElementById('rosterModalClose');
  el.rosterModalTitle = document.getElementById('rosterModalTitle');
  el.rosterModalMeta = document.getElementById('rosterModalMeta');
  el.rosterModalBody = document.getElementById('rosterModalBody');
  el.playerModal = document.getElementById('playerModal');
  el.playerModalClose = document.getElementById('playerModalClose');
  el.playerModalTitle = document.getElementById('playerModalTitle');
  el.playerModalMeta = document.getElementById('playerModalMeta');
  el.playerModalBody = document.getElementById('playerModalBody');
  el.toast = document.getElementById('toast');
  el.refreshHint = document.getElementById('refreshHint');
  el.authBtn = document.getElementById('authBtn');
  el.authModal = document.getElementById('authModal');
  el.authModalClose = document.getElementById('authModalClose');
  el.authUsername = document.getElementById('authUsername');
  el.authPassword = document.getElementById('authPassword');
  el.authError = document.getElementById('authError');
  el.authSubmit = document.getElementById('authSubmit');

  state.players = loadPlayers();
  applyImportOnce();
  applyBagImportOnce();
  state.hotThreshold = loadHotThreshold();
  state.view = loadView();
  buildSortSelect();
  bindEvents();
  startTicker();
  // 先把上次的快照读进内存，render() 会在没实时数据时用它把首屏填满，
  // 再由下面的 refresh() 更新到最新
  loadSnapshot();
  render();

  await refresh();
  loadHotStats();
  initAuth();
}

function bindEvents() {
  el.viewTabs.addEventListener('click', (event) => {
    const button = event.target.closest('[data-view]');
    if (button) switchView(button.dataset.view);
  });

  el.teamsView.addEventListener('click', (event) => {
    const filterButton = event.target.closest('[data-game-filter]');
    if (filterButton) {
      state.gameFilter = filterButton.dataset.gameFilter;
      renderTeamFilters();
      renderTeamGrid();
      return;
    }
    const rosterOpen = event.target.closest('[data-open-roster]');
    if (rosterOpen) {
      openRosterModal(rosterOpen.dataset.openRoster, rosterOpen);
      return;
    }
    const playerChip = event.target.closest('[data-team-player]');
    if (playerChip) {
      revealPlayer(playerChip.dataset.teamPlayer);
      return;
    }
    if (event.target.closest('[data-game-retry]')) manualRefresh();
    if (event.target.closest('[data-reset-game-filter]')) {
      state.gameFilter = 'all';
      renderTeamFilters();
      renderTeamGrid();
    }
  });

  el.addPlayerBtn.addEventListener('click', openModal);
  el.exportBtn.addEventListener('click', exportBackup);
  el.importBtn.addEventListener('click', () => el.importFile.click());
  el.importFile.addEventListener('change', onImportFileChange);
  el.modalClose.addEventListener('click', closeModal);
  el.modal.addEventListener('click', (event) => {
    if (event.target === el.modal) closeModal();
  });
  el.rosterModalClose.addEventListener('click', () => closeRosterModal());
  el.rosterModal.addEventListener('click', (event) => {
    if (event.target === el.rosterModal) closeRosterModal();
  });
  el.rosterModalBody.addEventListener('click', (event) => {
    const row = event.target.closest('[data-team-player]');
    if (!row) return;
    closeRosterModal({ restoreFocus: false });
    revealPlayer(row.dataset.teamPlayer);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!el.authModal.hidden) closeAuthModal();
    else if (!el.playerModal.hidden) closePlayerModal();
    else if (!el.rosterModal.hidden) closeRosterModal();
    else if (!el.modal.hidden) closeModal();
  });
  el.playerSearch.addEventListener('input', onSearchInput);
  el.playerSearch.addEventListener('compositionstart', () => {
    searchComposing = true;
    clearTimeout(searchDebounce);
    searchSeq += 1;
  });
  el.playerSearch.addEventListener('compositionend', () => {
    searchComposing = false;
    onSearchInput();
  });
  el.searchResults.addEventListener('click', onSearchResultClick);

  el.prevDate.addEventListener('click', () => shiftDate(-1));
  el.nextDate.addEventListener('click', () => shiftDate(1));
  el.todayDate.addEventListener('click', () => {
    if (!state.dateParam) return;
    state.dateParam = null;
    state.summaries = new Map();
    summaryFailCounts.clear();
    state.hasData = false;
    state.loadError = null;
    render();
    refresh();
  });

  el.refreshBtn.addEventListener('click', manualRefresh);
  el.retryBtn.addEventListener('click', manualRefresh);

  el.statusFilter.addEventListener('click', (event) => {
    const button = event.target.closest('[data-status]');
    if (!button) return;
    state.filterStatus = button.dataset.status;
    renderFilters();
    renderGrid();
  });

  el.teamFilter.addEventListener('change', () => {
    state.filterTeam = el.teamFilter.value;
    renderGrid();
  });

  el.sortSelect.addEventListener('change', () => applySort(el.sortSelect.value));

  el.summaryBar.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-leader-sort]');
    if (chip) applySort(chip.dataset.leaderSort);
  });

  el.hotThreshold.addEventListener('change', () => {
    const value = Math.min(30, Math.max(1, Number(el.hotThreshold.value) || DEFAULT_HOT_THRESHOLD));
    el.hotThreshold.value = String(value);
    state.hotThreshold = value;
    saveHotThreshold(value);
    renderSummary();
    renderFilters();
    renderGrid();
    showToast(`火热阈值已设为 ${value} 场`);
  });

  el.sortDirBtn.addEventListener('click', () => {
    state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
    updateSortDir();
    renderGrid();
  });

  el.grid.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove]');
    if (button) {
      removePlayer(button.dataset.remove);
      return;
    }
    // 点卡片任意非按钮区域 → 打开该球员的本赛季逐场记录
    const card = event.target.closest('[data-player-id]');
    if (card) openPlayerModal(card.dataset.playerId);
  });

  el.playerModalClose.addEventListener('click', closePlayerModal);
  el.playerModal.addEventListener('click', (event) => {
    if (event.target === el.playerModal) closePlayerModal();
  });

  el.hotBar.addEventListener('click', (event) => {
    const card = event.target.closest('[data-hot-player]');
    if (card) revealPlayer(card.dataset.hotPlayer);
  });

  el.authBtn.addEventListener('click', onAuthButtonClick);
  el.authModalClose.addEventListener('click', closeAuthModal);
  el.authModal.addEventListener('click', (event) => {
    if (event.target === el.authModal) closeAuthModal();
  });
  el.authSubmit.addEventListener('click', submitAuth);
  el.authPassword.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitAuth();
  });
  el.authUsername.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') el.authPassword.focus();
  });

  bindHScroll();

  el.emptyState.addEventListener('click', (event) => {
    if (event.target.closest('[data-open-add]')) openModal();
    if (event.target.closest('[data-retry]')) manualRefresh();
    if (event.target.closest('[data-reset-filters]')) {
      state.filterStatus = 'all';
      state.filterTeam = 'all';
      renderFilters();
      renderGrid();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      secondsLeft = REFRESH_SECONDS;
      updateLiveClocks();
      maybeAnnounceHot();
    }
  });
}

/* ---------- 横向滚动增强（打得好 / 今日榜首） ---------- */

const HSCROLL_SELECTOR = '.hotbar-track, .sl-track';
let hScrollDrag = null;

// 滚轮竖滚转横滚 + 鼠标按住拖拽横滚；两个轨道都会每 10 秒重建，所以用事件委托
function bindHScroll() {
  document.addEventListener(
    'wheel',
    (event) => {
      const track = event.target instanceof Element ? event.target.closest(HSCROLL_SELECTOR) : null;
      if (!track || event.ctrlKey) return;
      const max = track.scrollWidth - track.clientWidth;
      if (max <= 0) return;
      // 只把「竖向滚轮」转成横滚；触摸板双指横滑（deltaX 为主）交给浏览器原生处理，避免双重滚动
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const delta = event.deltaY;
      if (!delta) return;
      // 已经滚到头就把滚轮还给页面
      if ((delta < 0 && track.scrollLeft <= 0) || (delta > 0 && track.scrollLeft >= max - 1)) return;
      track.scrollLeft += delta;
      event.preventDefault();
    },
    { passive: false }
  );

  document.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    // 只对鼠标做拖拽横滚；触屏/触摸板走原生滚动
    if (event.pointerType !== 'mouse') return;
    const track = event.target.closest(HSCROLL_SELECTOR);
    if (!track) return;
    hScrollDrag = {
      track,
      pointerId: event.pointerId,
      startX: event.clientX,
      startScroll: track.scrollLeft,
      moved: false,
    };
  });

  document.addEventListener('pointermove', (event) => {
    if (!hScrollDrag || event.pointerId !== hScrollDrag.pointerId) return;
    const dx = event.clientX - hScrollDrag.startX;
    if (!hScrollDrag.moved) {
      if (Math.abs(dx) < 5) return; // 小于 5px 算点击，不拖拽
      hScrollDrag.moved = true;
      hScrollDrag.track.classList.add('dragging');
      document.body.classList.add('hscroll-dragging');
    }
    hScrollDrag.track.scrollLeft = hScrollDrag.startScroll - dx;
    event.preventDefault();
  });

  const endDrag = (event) => {
    if (!hScrollDrag || (event && event.pointerId !== hScrollDrag.pointerId)) return;
    const dragged = hScrollDrag.moved;
    hScrollDrag.track.classList.remove('dragging');
    document.body.classList.remove('hscroll-dragging');
    hScrollDrag = null;
    if (!dragged) return;
    // 拖拽过后不要顺带触发卡片的点击
    const swallowClick = (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      document.removeEventListener('click', swallowClick, true);
    };
    document.addEventListener('click', swallowClick, true);
    setTimeout(() => document.removeEventListener('click', swallowClick, true), 0);
  };

  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);
}

/* ---------- 账号：登录即注册 + 云端同步 ---------- */

function loadAuthToken() {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch (error) {
    return null;
  }
}

function saveAuthToken(token) {
  try {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
  } catch (error) {
    /* storage may be unavailable */
  }
}

function clearAuthToken() {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
  } catch (error) {
    /* ignore */
  }
}

/** 带登录态的请求；401 时自动退回本地模式（不清空本机数据） */
async function authFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers['Content-Type'] = 'application/json';
  let requestUrl = url;
  if (state.auth.token) {
    headers.Authorization = 'Bearer ' + state.auth.token;
    // 部分部署网关会剥离 Authorization，同时用自定义头与查询参数兜底
    headers['X-Auth-Token'] = state.auth.token;
    requestUrl = url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(state.auth.token);
  }
  const response = await fetch(requestUrl, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && state.auth.token) {
    clearAuthToken();
    state.auth.token = null;
    state.auth.user = null;
    updateAuthUi();
  }
  if (!response.ok) throw new Error(data.error || '请求失败（HTTP ' + response.status + '）');
  return data;
}

function collectCloudData() {
  return {
    version: STORE_VERSION,
    players: state.players,
    hotThreshold: state.hotThreshold,
    view: state.view,
    hotAlertStore,
  };
}

/** 用云端数据覆盖本机状态；直接写 localStorage，不触发回推，避免同步循环 */
function applyCloudData(data) {
  if (!data || typeof data !== 'object') return false;
  let applied = false;

  if (Array.isArray(data.players)) {
    state.players = data.players;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ version: STORE_VERSION, players: state.players }));
    } catch (error) {
      /* ignore */
    }
    applied = true;
  }
  if (Number.isFinite(data.hotThreshold) && data.hotThreshold >= 1 && data.hotThreshold <= 30) {
    state.hotThreshold = data.hotThreshold;
    try {
      localStorage.setItem(HOT_THRESHOLD_KEY, String(data.hotThreshold));
    } catch (error) {
      /* ignore */
    }
    if (el.hotThreshold) el.hotThreshold.value = String(data.hotThreshold);
    applied = true;
  }
  if (data.view === 'teams' || data.view === 'players') {
    state.view = data.view;
    try {
      localStorage.setItem(VIEW_KEY, state.view);
    } catch (error) {
      /* ignore */
    }
    applied = true;
  }
  if (data.hotAlertStore && typeof data.hotAlertStore === 'object' && !Array.isArray(data.hotAlertStore)) {
    hotAlertStore = data.hotAlertStore;
    try {
      localStorage.setItem(HOT_ALERT_KEY, JSON.stringify(hotAlertStore));
    } catch (error) {
      /* ignore */
    }
    applied = true;
  }
  return applied;
}

async function pushCloudData() {
  if (!state.auth.token) return;
  try {
    await authFetch('/api/data', { method: 'PUT', body: JSON.stringify(collectCloudData()) });
  } catch (error) {
    showToast('云端同步失败：' + error.message);
  }
}

let cloudSyncTimer = null;

/** 本地数据变更后防抖推送；未登录时只在本地保存 */
function scheduleCloudSync() {
  if (!state.auth.token) return;
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => {
    pushCloudData();
  }, CLOUD_SYNC_DEBOUNCE_MS);
}

/** 登录后拉取云端数据；云端为空则把本机数据迁移上去 */
async function pullCloudData() {
  const result = await authFetch('/api/data');
  if (result && result.data && Object.keys(result.data).length > 0) {
    if (applyCloudData(result.data)) {
      state.rows = buildRows();
      render();
      showToast('已从云端恢复关注名单等数据');
    }
  } else {
    await pushCloudData();
    showToast('本机数据已保存到云端');
  }
}

async function initAuth() {
  const token = loadAuthToken();
  if (!token) {
    state.auth.ready = true;
    updateAuthUi();
    return;
  }
  state.auth.token = token;
  try {
    const me = await authFetch('/api/me');
    state.auth.user = me.user;
    await pullCloudData();
  } catch (error) {
    // token 失效或网络异常：保持本地模式继续使用
    state.auth.token = null;
    state.auth.user = null;
  }
  state.auth.ready = true;
  updateAuthUi();
}

function openAuthModal() {
  el.authError.hidden = true;
  el.authModal.hidden = false;
  document.body.classList.add('modal-open');
  setTimeout(() => el.authUsername.focus(), 0);
}

function closeAuthModal() {
  el.authModal.hidden = true;
  if (el.modal.hidden && el.rosterModal.hidden) document.body.classList.remove('modal-open');
}

function showAuthError(message) {
  el.authError.textContent = message;
  el.authError.hidden = false;
}

function onAuthButtonClick() {
  if (state.auth.user) {
    const ok = window.confirm(`当前已登录：${state.auth.user.name}\n确定退出登录吗？（本机数据会保留）`);
    if (ok) logout();
    return;
  }
  openAuthModal();
}

/** 登录即注册：服务端对不存在的账号自动创建 */
async function submitAuth() {
  const username = el.authUsername.value.trim();
  const password = el.authPassword.value;
  if (!username || !password) {
    showAuthError('请输入用户名和密码');
    return;
  }
  el.authSubmit.disabled = true;
  el.authSubmit.textContent = '登录中…';
  try {
    const result = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }).then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || '登录失败（HTTP ' + response.status + '）');
      return data;
    });
    state.auth.token = result.token;
    state.auth.user = result.user;
    saveAuthToken(result.token);
    el.authPassword.value = '';
    closeAuthModal();
    updateAuthUi();
    showToast(result.created ? `账号 ${result.user.name} 已创建，欢迎加入` : `欢迎回来，${result.user.name}`);
    await pullCloudData();
  } catch (error) {
    showAuthError(error.message);
  } finally {
    el.authSubmit.disabled = false;
    el.authSubmit.textContent = '登录 / 自动注册';
  }
}

async function logout() {
  try {
    await authFetch('/api/logout', { method: 'POST' });
  } catch (error) {
    /* 退出失败也继续清本地登录态 */
  }
  clearAuthToken();
  state.auth.token = null;
  state.auth.user = null;
  updateAuthUi();
  showToast('已退出登录，数据仍保存在本机');
}

function updateAuthUi() {
  if (!el.authBtn) return;
  const user = state.auth.user;
  el.authBtn.textContent = user ? user.name : '登录';
  el.authBtn.title = user ? `已登录：${user.name}（点击退出）` : '登录即注册，数据云同步';
  el.authBtn.classList.toggle('logged-in', Boolean(user));
}

/* ---------- data ---------- */

function loadPlayers() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (Array.isArray(data.players)) {
        if (data.version >= STORE_VERSION) return data.players;
        const merged = migratePlayers(data.players);
        state.players = merged;
        savePlayers();
        return merged;
      }
    }
  } catch (error) {
    /* ignore corrupt storage */
  }
  return SEED_PLAYERS.map((player) => ({ ...player }));
}

function migratePlayers(saved) {
  const seen = new Set(saved.map((player) => String(player.id)));
  const merged = saved.map((player) => {
    const seed = SEED_PLAYERS.find((item) => item.id === String(player.id));
    return seed ? { ...player, ...seed, cn: player.cn || seed.cn } : player;
  });
  for (const seed of SEED_PLAYERS) {
    if (!seen.has(seed.id)) merged.push({ ...seed });
  }
  return merged;
}

/** 把 IMPORT_PLAYERS 并入关注列表，只执行一次（按 id 去重，不动已有条目） */
function applyImportOnce() {
  try {
    if (localStorage.getItem(IMPORT_ONCE_KEY)) return;
  } catch (error) {
    return;
  }

  const seen = new Set(state.players.map((player) => String(player.id)));
  let added = 0;
  for (const player of IMPORT_PLAYERS) {
    if (seen.has(player.id)) continue;
    state.players.push({ headshot: '', group: 'watch', ...player });
    seen.add(player.id);
    added += 1;
  }

  savePlayers();
  try {
    localStorage.setItem(IMPORT_ONCE_KEY, JSON.stringify({ added, at: Date.now() }));
  } catch (error) {
    /* storage may be unavailable */
  }
  if (added) console.info(`[NBA 看台] 已并入 ${added} 位收藏球员`);
}

/** 背包名单：已关注的打标记，未关注的加入并标记为背包组 */
function applyBagImportOnce() {
  try {
    if (localStorage.getItem(BAG_IMPORT_KEY)) return;
  } catch (error) {
    return;
  }

  let marked = 0;
  let added = 0;
  for (const player of BAG_PLAYERS) {
    const existing = state.players.find((item) => String(item.id) === player.id);
    if (existing) {
      existing.group = 'bag';
      marked += 1;
    } else {
      state.players.push({ headshot: '', group: 'bag', ...player });
      added += 1;
    }
  }

  savePlayers();
  try {
    localStorage.setItem(BAG_IMPORT_KEY, JSON.stringify({ marked, added, at: Date.now() }));
  } catch (error) {
    /* storage may be unavailable */
  }
  if (marked + added) console.info(`[NBA 看台] 背包球员：标记 ${marked} 人，新增 ${added} 人`);
}

function playerGroup(player) {
  return player?.group === 'bag' ? 'bag' : 'watch';
}

/* ---------- 打得好的稳定性统计 ---------- */

function loadHotThreshold() {
  try {
    const raw = Number(localStorage.getItem(HOT_THRESHOLD_KEY));
    if (Number.isFinite(raw) && raw >= 1 && raw <= 30) return raw;
  } catch (error) {
    /* ignore */
  }
  return DEFAULT_HOT_THRESHOLD;
}

function saveHotThreshold(value) {
  try {
    localStorage.setItem(HOT_THRESHOLD_KEY, String(value));
  } catch (error) {
    /* ignore */
  }
  scheduleCloudSync();
}

function hotStatsFor(id) {
  const stats = state.hotStats[String(id)];
  return stats && stats.games ? stats : null;
}

/** stable = 达标且达到阈值；flash = 达标但没到阈值；none = 一次都没达标 */
function hotVerdict(stats) {
  if (!stats || !stats.games) return 'none';
  if (stats.hotGames >= state.hotThreshold) return 'stable';
  if (stats.hotGames > 0) return 'flash';
  return 'none';
}

function parsePair(value) {
  if (value == null) return null;
  const text = String(value).trim();
  const match = text.match(/^(\d+)-(\d+)$/);
  if (!match) return null;
  return { made: Number(match[1]), att: Number(match[2]) };
}

function toNumber(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || text === '-') return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseMinutes(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || text === '--' || text === '-') return null;
  if (text.includes(':')) {
    const [m, s] = text.split(':');
    return Number(m) + Number(s) / 60;
  }
  return toNumber(text);
}

/** 用 gamelog 的一行原始统计构造当日同口径的 stats，再复用 hotReasons 判定 */
function gameLogStats(row, index) {
  const fg = parsePair(row[index['FG']]);
  const ft = parsePair(row[index['FT']]);
  const tp = parsePair(row[index['3PT']]);
  const stats = {
    minutes: parseMinutes(row[index['MIN']]),
    pts: toNumber(row[index['PTS']]) || 0,
    reb: toNumber(row[index['REB']]) || 0,
    ast: toNumber(row[index['AST']]) || 0,
    stl: toNumber(row[index['STL']]) || 0,
    blk: toNumber(row[index['BLK']]) || 0,
    fga: fg ? fg.att : 0,
    fta: ft ? ft.att : 0,
    tpm: tp ? tp.made : 0,
    tpa: tp ? tp.att : 0,
    plusMinus: null,
  };
  const shots = stats.fga + 0.44 * stats.fta;
  stats.ts = shots > 0 ? (stats.pts / (2 * shots)) * 100 : null;
  return stats;
}

async function parseGamelog(data, playerId) {
  const labels = data?.labels || [];
  const index = {};
  labels.forEach((label, position) => {
    index[label] = position;
  });
  const result = { games: 0, hotGames: 0, hotDates: [], log: [] };
  if (index['PTS'] === undefined) return result;

  const events = data.events || {};
  // 只取常规赛；没有常规赛数据时才退回全部（例如赛季尚未开打）
  const regular = (data.seasonTypes || []).filter((type) => /regular/i.test(type.displayName || ''));
  const sources = regular.length ? regular : data.seasonTypes || [];

  // 先按「不依赖正负值的维度」逐场打分，gamelog 里没有 +/-，需要补查
  const rows = [];
  for (const seasonType of sources) {
    for (const category of seasonType.categories || []) {
      for (const [fallbackId, entry] of Object.entries(category.events || {})) {
        const row = entry?.stats;
        if (!Array.isArray(row)) continue;
        const stats = gameLogStats(row, index);
        if (stats.minutes == null || stats.minutes <= 0) continue; // 未出场不计
        const eventId = String(entry?.eventId || fallbackId);
        const date = events[eventId]?.gameDate;
        // 被否决的场次直接记 0 项，也就不必再为它补查正负值
        const dq = hotDisqualifier(stats);
        rows.push({
          eventId,
          stats,
          dq,
          date: date ? String(date).slice(0, 10) : null,
          disqualified: dq != null,
          reasons: dq ? [] : collectHotReasons(stats, HOT_RULES_SEASON) || [],
        });
      }
    }
  }
  result.games = rows.length;

  // 只有「差一项就达标」的场次，补上正负值才可能改变结论：
  // 0 项补了也只有 1 项，≥2 项本来就已经算数，这两类都不用查。
  const needPlusMinus = rows.filter((row) => row.reasons.length === HOT_MIN_RULES - 1);
  const plusMinus = needPlusMinus.length
    ? await fetchPlusMinus(needPlusMinus.map((row) => row.eventId))
    : {};

  for (const row of rows) {
    const reasons = row.reasons.slice();
    if (reasons.length === HOT_MIN_RULES - 1) {
      const value = plusMinus[row.eventId]?.[String(playerId)];
      if (typeof value === 'number' && value >= 10) {
        reasons.push({ key: 'pm', label: '正负+10' });
      }
    }
    const isHot = reasons.length >= HOT_MIN_RULES;
    if (isHot) {
      result.hotGames += 1;
      if (row.date) result.hotDates.push(row.date);
    }

    // 逐场明细：供卡片详情弹窗展示，字段名压到最短以控制缓存体积
    const meta = events[row.eventId] || {};
    const s = row.stats;
    result.log.push({
      e: row.eventId,
      d: row.date,
      o: meta.opponent?.abbreviation || '',
      v: meta.atVs || 'vs',
      sc: meta.score || '',
      r: meta.gameResult || '',
      min: Math.round(s.minutes),
      pts: s.pts,
      reb: s.reb,
      ast: s.ast,
      stl: s.stl,
      blk: s.blk,
      ts: s.ts == null ? null : Math.round(s.ts * 10) / 10,
      hot: isHot,
      k: reasons.map((reason) => reason.key),
      dq: row.dq || null,
    });
  }

  // 最近的比赛排在最前
  result.log.sort((a, b) => String(b.d || '').localeCompare(String(a.d || '')));
  result.hotDates.sort();
  return result;
}

/** 批量补查若干场比赛的正负值；服务端按比赛缓存，多球员共享同一份结果 */
async function fetchPlusMinus(eventIds) {
  const ids = [...new Set(eventIds)];
  if (!ids.length) return {};
  // 服务端单次最多 40 场，这里分批，避免赛季中后期场次变多后被拒
  const BATCH = 40;
  const result = {};
  for (let i = 0; i < ids.length; i += BATCH) {
    try {
      const data = await fetchJSON(`/api/plusminus?events=${ids.slice(i, i + BATCH).join(',')}`);
      if (data && typeof data === 'object') Object.assign(result, data);
    } catch (error) {
      // 单批失败就跳过，退回「不含该维度」的口径，不影响其他批次
    }
  }
  return result;
}

function readHotStatsCache() {
  try {
    const raw = localStorage.getItem(HOT_STATS_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !data.players) return null;
    // 判定规则改过就作废旧缓存，否则会一直显示旧口径算出来的场次
    if (data.rulesVersion !== HOT_RULES_VERSION) return null;
    const at = Number(data.at);
    if (!Number.isFinite(at) || Date.now() - at > HOT_STATS_TTL_MS) return null;
    return data;
  } catch (error) {
    /* ignore */
  }
  return null;
}

function writeHotStatsCache(players) {
  try {
    localStorage.setItem(
      HOT_STATS_KEY,
      JSON.stringify({
        date: currentEtDate(),
        at: Date.now(),
        rulesVersion: HOT_RULES_VERSION,
        players,
        version: STORE_VERSION,
      })
    );
  } catch (error) {
    /* ignore */
  }
}

async function fetchHotStats(playerId) {
  // 只统计当前赛季；不做「取不到就退回默认」的兜底，
  // 否则会把上一个完整赛季的场次算进来，虚高成一整个赛季。
  try {
    const data = await fetchJSON(GAMELOG_API(playerId, currentSeasonYear()));
    return await parseGamelog(data, playerId);
  } catch (error) {
    return { games: 0, hotGames: 0, hotDates: [] };
  }
}

/** NBA 赛季从 10 月起算，9 月之后归到次年（2026-27 赛季 => 2027） */
function currentSeasonYear() {
  const now = new Date();
  return now.getMonth() >= 8 ? now.getFullYear() + 1 : now.getFullYear();
}

/** 并发池拉取全部关注球员的赛季 gamelog，算「打得好」场次；当日只拉一次 */
async function loadHotStats(force = false) {
  if (state.hotStatsLoading) return;
  state.hotStatsLoading = true;

  try {
    const cached = force ? null : readHotStatsCache();
    const todo = cached ? state.players.filter((p) => !cached.players[p.id]) : state.players;
    if (cached) state.hotStats = { ...cached.players };
    // 先把当前状态画出来：有缓存直接显示真实场次，没有就先挂「统计中…」
    renderGrid();

    if (todo.length) {
      showToast(`正在统计赛季火热场次（${todo.length} 人）…`);
      // 并发池设为 4：浏览器同一域名最多 6 个连接，留 2 个给登录、搜索等交互请求
      const pool = 4;
      let done = 0;
      let cursor = 0;
      const workers = Array.from({ length: Math.min(pool, todo.length) }, async () => {
        while (cursor < todo.length) {
          const player = todo[cursor];
          cursor += 1;
          try {
            state.hotStats[player.id] = await fetchHotStats(player.id);
          } catch (error) {
            state.hotStats[player.id] = { games: 0, hotGames: 0, hotDates: [] };
          }
          done += 1;
          if (done % 10 === 0 || done === todo.length) {
            showToast(`正在统计赛季火热场次 ${done}/${todo.length}`);
          }
          // 每算完一个人就刷新一次，用户能逐个看到结果，不必等全部拉完
          try {
            renderGrid();
          } catch (error) {
            /* 单次渲染失败不影响后续拉取 */
          }
        }
      });
      await Promise.all(workers);
      // 全部请求失败时不写缓存，避免把「0 场」的脏数据锁一整天
      const anyData = Object.values(state.hotStats).some((item) => item && item.games > 0);
      if (anyData) writeHotStatsCache(state.hotStats);
    }

    state.hotStatsLoaded = true;
    const stable = stableRows().length;
    const flash = flashRows().length;
    if (stable + flash) {
      showToast(`赛季火热：稳定 ${stable} 人 · 昙花一现 ${flash} 人（阈值 ${state.hotThreshold} 场）`);
    }
  } catch (error) {
    // 拉取中途出错也要让卡片从「统计中」回到正常状态
    console.warn('赛季火热统计失败', error);
  } finally {
    state.hotStatsLoading = false;
    // 无论成功失败都标记为「已尝试」，卡片才会从「统计中」切到最终状态
    state.hotStatsLoaded = true;
    try {
      renderSummary();
      renderFilters();
      renderGrid();
    } catch (error) {
      console.warn('赛季火热渲染失败', error);
    }
  }
}

function stableRows() {
  return state.rows.filter((row) => hotVerdict(hotStatsFor(row.player.id)) === 'stable');
}

function flashRows() {
  return state.rows.filter((row) => hotVerdict(hotStatsFor(row.player.id)) === 'flash');
}

function savePlayers() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ version: STORE_VERSION, players: state.players }));
  } catch (error) {
    /* storage may be unavailable */
  }
  scheduleCloudSync();
}

async function fetchJSON(url, options = {}) {
  const controller = new AbortController();
  // 25 秒：跨境部署 + 首次无缓存时，单场技术统计的往返可能接近 10 秒
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: options.headers,
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 首屏快照：把当前渲染结果存进 localStorage。
 * 存 HTML 而不是原始 summary，是因为 12 场 summary 约 6MB，会直接撑爆配额；
 * 页面用的是事件委托，innerHTML 还原不会丢交互。
 */
function saveSnapshot() {
  if (!state.hasData || !el.grid) return;
  try {
    localStorage.setItem(
      SNAPSHOT_KEY,
      JSON.stringify({
        at: Date.now(),
        dateParam: state.dateParam,
        grid: el.grid.innerHTML,
        teamGrid: el.teamGrid ? el.teamGrid.innerHTML : '',
        teamSummary: el.teamSummary ? el.teamSummary.innerHTML : '',
        summaryBar: el.summaryBar ? el.summaryBar.innerHTML : '',
        updatedText: el.updatedAt ? el.updatedAt.textContent : '',
      })
    );
  } catch (error) {
    /* 配额不足或隐私模式：跳过缓存，不影响正常使用 */
  }
}

/** 读出本地快照到内存；日期或时效不符时不使用 */
function loadSnapshot() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return false;
    const snap = JSON.parse(raw);
    if (!snap || !snap.grid) return false;
    snapshotPayload = snap;
    return Boolean(activeSnapshot());
  } catch (error) {
    return false;
  }
}

/** 当前日期可用、且没过期的快照；切换日期后旧快照不能拿来充数 */
function activeSnapshot() {
  if (!snapshotPayload) return null;
  if (snapshotPayload.dateParam !== state.dateParam) return null;
  if (Date.now() - snapshotPayload.at > SNAPSHOT_MAX_AGE_MS) return null;
  return snapshotPayload;
}

/** 当日没有比赛，或所有比赛都已结束 → 没必要继续自动刷新 */
function slateIsSettled() {
  if (!state.hasData) return false;
  if (!state.games.length) return true;
  return state.games.every((game) => game.state === 'final');
}

/** 还有技术统计缺着、且没超过重试上限 → 仍需要继续刷新把它们补齐 */
function statsIncomplete() {
  for (const count of summaryFailCounts.values()) {
    if (count > 0 && count < SUMMARY_MAX_ATTEMPTS) return true;
  }
  return false;
}

/** 技术统计占位文案：失败到上限后不再显示「同步中」，避免看起来像卡死 */
function summaryPendingText(gameId) {
  return (summaryFailCounts.get(gameId) || 0) >= SUMMARY_MAX_ATTEMPTS
    ? '球队技术统计暂不可用 · 点右上角刷新重试'
    : '球队技术统计同步中…';
}

function playerPendingText(gameId) {
  return (summaryFailCounts.get(gameId) || 0) >= SUMMARY_MAX_ATTEMPTS
    ? '统计暂不可用 · 点右上角刷新'
    : '技术统计同步中';
}

/**
 * 并发池拉取技术统计。
 * 之前是一次性把十几场全发出去：手机端每域名连接数有限（约 6 个），
 * 排队尾巴很容易超过请求超时被中断，导致个别比赛永远停在「同步中」。
 */
async function fetchSummariesPooled(eventIds, attempts = 2, force = false) {
  const results = new Array(eventIds.length).fill(null);
  const headers = force ? { 'X-Force-Refresh': '1' } : undefined;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(SUMMARY_POOL_SIZE, eventIds.length) }, async () => {
    while (cursor < eventIds.length) {
      const index = cursor;
      cursor += 1;
      const id = eventIds[index];
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          results[index] = await fetchJSON(API.summary(id), { headers });
          break;
        } catch (error) {
          if (attempt === attempts) {
            results[index] = null;
          } else {
            await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
          }
        }
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function refresh() {
  if (state.refreshing) {
    state.pendingRefresh = true;
    return;
  }
  state.refreshing = true;
  const requestedDate = state.dateParam;
  // 用户点刷新时穿透服务端缓存；自动刷新沿用缓存，避免白拉
  const force = bypassCacheOnce;
  bypassCacheOnce = false;
  let announceHot = false;
  el.refreshBtn.classList.add('spinning');
  renderUpdated();

  try {
    const scoreboard = await fetchJSON(
      API.scoreboard(requestedDate),
      force ? { headers: { 'X-Force-Refresh': '1' } } : {}
    );
    if (requestedDate !== state.dateParam) return;
    state.slateDate = requestedDate
      ? paramToDate(requestedDate)
      : scoreboard.day?.date || currentEtDate();
    state.games = (scoreboard.events || []).map(normalizeEvent);

    const summaries = new Map();
    const eventIds = [];
    for (const game of state.games) {
      if (game.state === 'pre') continue;
      const cached = state.summaries.get(game.id);
      if (game.state === 'final' && summaryIsFinal(cached)) {
        summaries.set(game.id, cached);
      } else {
        eventIds.push(game.id);
      }
    }

    const fetched = await fetchSummariesPooled(eventIds, 2, force);
    eventIds.forEach((id, index) => {
      if (fetched[index]) {
        summaries.set(id, fetched[index]);
        summaryFailCounts.delete(id);
      } else if (state.summaries.has(id)) {
        // 本次失败但之前拿到过，沿用旧数据，不算缺失
        summaries.set(id, state.summaries.get(id));
      } else {
        summaryFailCounts.set(id, (summaryFailCounts.get(id) || 0) + 1);
      }
    });

    state.summaries = summaries;
    state.gameMeta = new Map();
    for (const game of state.games) {
      state.gameMeta.set(game.id, buildGameMeta(game, summaries.get(game.id)));
    }
    state.lastUpdated = new Date();
    state.hasData = true;
    state.loadError = null;
    state.rows = buildRows();
    // 当日无比赛或全部结束、且技术统计都拿齐了，才停止自动刷新
    secondsLeft = slateIsSettled() && !statsIncomplete() ? 0 : REFRESH_SECONDS;
    announceHot = true;
    hideError();
  } catch (error) {
    state.loadError = error;
    showError(error);
  } finally {
    state.refreshing = false;
    el.refreshBtn.classList.remove('spinning');
    render();
    if (!state.loadError) saveSnapshot();
    if (announceHot) maybeAnnounceHot();
    if (state.pendingRefresh) {
      state.pendingRefresh = false;
      setTimeout(refresh, 60);
    }
  }
}

function normalizeEvent(event) {
  const competition = event.competitions?.[0] || {};
  for (const entry of competition.competitors || []) registerTeam(entry.team);
  const rawState = competition.status?.type?.state || 'pre';
  return {
    id: String(event.id),
    date: event.date,
    state: rawState === 'in' ? 'live' : rawState === 'post' ? 'final' : 'pre',
    statusName: competition.status?.type?.name || '',
    detail: competition.status?.type?.detail || '',
    clock: competition.status?.displayClock || '',
    period: competition.status?.period || 0,
    venue: competition.venue?.fullName || '',
    competitors: (competition.competitors || []).map((entry) => ({
      teamId: String(entry.team?.id),
      abbr: entry.team?.abbreviation || '',
      name: entry.team?.displayName || '',
      short: entry.team?.shortDisplayName || entry.team?.name || '',
      logo: entry.team?.logo || teamLogo(entry.team?.abbreviation),
      score: entry.score != null ? String(entry.score) : '0',
      record: entry.records?.find((record) => record.type === 'total')?.summary || '',
      homeAway: entry.homeAway,
      winner: Boolean(entry.winner),
    })),
  };
}

function summaryIsFinal(summary) {
  return summary?.header?.competitions?.[0]?.status?.type?.state === 'post';
}

function buildRows() {
  const dayWord = state.dateParam ? '当日' : '今日';
  return state.players.map((player) => {
    const team = state.teams.get(String(player.teamId)) || null;
    const row = {
      player,
      team,
      game: null,
      me: null,
      opp: null,
      state: 'idle',
      statusLabel: dayWord + '无比赛',
      statusText: '',
      played: false,
      onCourt: null,
      meta: null,
      stats: null,
      hot: null,
      reason: '',
    };

    if (!player.teamId) {
      row.statusLabel = '无球队';
      return row;
    }

    const game = state.games.find((item) =>
      item.competitors.some((teamEntry) => teamEntry.teamId === String(player.teamId))
    );
    if (!game) return row;

    const me = game.competitors.find((teamEntry) => teamEntry.teamId === String(player.teamId));
    const opp = game.competitors.find((teamEntry) => teamEntry.teamId !== String(player.teamId));
    row.game = game;
    row.me = me;
    row.opp = opp;
    row.meta = state.gameMeta.get(game.id) || null;
    row.statusText =
      game.state === 'live'
        ? liveStatusText(game, row.meta)
        : game.state === 'final'
          ? '已结束'
          : `开赛 ${formatTip(game.date)}`;

    if (game.state === 'pre') {
      row.state = 'pre';
      row.statusLabel = '未开始';
      return row;
    }

    const summary = state.summaries.get(game.id);
    if (!summary) {
      row.state = 'unknown';
      row.statusLabel =
        (summaryFailCounts.get(game.id) || 0) >= SUMMARY_MAX_ATTEMPTS ? '暂不可用' : '同步中';
      return row;
    }

    const stats = extractStats(summary, String(player.teamId), String(player.id));
    if (stats && stats.minutes > 0) {
      row.played = true;
      row.stats = stats;
      row.hot = hotReasons(stats);
      // 达标项够了但被否决时记下原因，卡片悬停能看出为什么没打标
      row.dq = row.hot ? null : hotDisqualifier(stats);
      row.state = game.state === 'live' ? 'live' : 'final';
      if (game.state === 'live') {
        row.onCourt = row.meta?.halftime || row.meta?.endPeriod ? false : stats.active;
        row.statusLabel = row.meta?.halftime ? '中场' : row.meta?.endPeriod ? '节间' : '进行中';
      } else {
        row.statusLabel = '已结束';
      }
    } else {
      row.state = 'bench';
      row.statusLabel = '未上场';
      row.reason = reasonText(stats?.reason);
    }
    return row;
  });
}

function extractStats(summary, teamId, playerId) {
  const teamBoxes = summary?.boxscore?.players || [];
  const teamBox = teamBoxes.find((box) => String(box.team?.id) === teamId);
  if (!teamBox) return null;

  let group = null;
  let entry = null;
  for (const candidate of teamBox.statistics || []) {
    const found = (candidate.athletes || []).find((athlete) => String(athlete.athlete?.id) === playerId);
    if (found) {
      group = candidate;
      entry = found;
      break;
    }
  }
  if (!entry) return null;

  const raw = {};
  (group.keys || []).forEach((key, index) => {
    raw[key] = entry.stats?.[index] ?? null;
  });

  const minutes = parseMinutes(raw.minutes);
  const pts = num(raw.points);
  const reb = num(raw.rebounds);
  const ast = num(raw.assists);
  const stl = num(raw.steals);
  const blk = num(raw.blocks);
  const tov = num(raw.turnovers);
  const oreb = num(raw.offensiveRebounds);
  const dreb = num(raw.defensiveRebounds);
  const fg = parseSplit(raw['fieldGoalsMade-fieldGoalsAttempted']);
  const tp = parseSplit(raw['threePointFieldGoalsMade-threePointFieldGoalsAttempted']);
  const ft = parseSplit(raw['freeThrowsMade-freeThrowsAttempted']);
  const plusMinus = parsePlusMinus(raw.plusMinus);
  const advanced = computeAdvancedStats({
    minutes,
    pts,
    reb,
    ast,
    stl,
    blk,
    tov,
    fg,
    tp,
    ft,
    teamTotals: teamTotals(summary, teamId),
    oppTotals: opponentTotals(summary, teamId),
  });

  return {
    minutes,
    pts,
    reb,
    ast,
    stl,
    blk,
    tov,
    oreb,
    dreb,
    pf: num(raw.fouls),
    fgm: fg.made,
    fga: fg.att,
    tpm: tp.made,
    tpa: tp.att,
    ftm: ft.made,
    fta: ft.att,
    plusMinus,
    ...advanced,
    reason: entry.reason || '',
    active: typeof entry.active === 'boolean' ? entry.active : null,
  };
}

function extractTeamStats(summary, teamId) {
  const box = (summary?.boxscore?.teams || []).find((item) => String(item.team?.id) === String(teamId));
  if (!box) return null;
  const map = {};
  for (const stat of box.statistics || []) map[stat.name] = stat.displayValue ?? '';
  const pct = (name) => {
    const parsed = parseFloat(String(map[name] ?? '').replace('%', ''));
    return Number.isFinite(parsed) ? parsed : null;
  };

  return {
    fg: parseSplit(map['fieldGoalsMade-fieldGoalsAttempted']),
    fgPct: pct('fieldGoalPct'),
    tp: parseSplit(map['threePointFieldGoalsMade-threePointFieldGoalsAttempted']),
    tpPct: pct('threePointFieldGoalPct'),
    ft: parseSplit(map['freeThrowsMade-freeThrowsAttempted']),
    ftPct: pct('freeThrowPct'),
    reb: num(map.totalRebounds),
    oreb: num(map.offensiveRebounds),
    dreb: num(map.defensiveRebounds),
    ast: num(map.assists),
    stl: num(map.steals),
    blk: num(map.blocks),
    tov: num(map.totalTurnovers ?? map.turnovers),
    pitp: num(map.pointsInPaint),
    fastBreak: num(map.fastBreakPoints),
    largestLead: num(map.largestLead),
  };
}

function computeAdvancedStats({ minutes, pts, reb, ast, stl, blk, tov, fg, tp, ft, teamTotals: team, oppTotals }) {
  const ts = fg.att + 0.44 * ft.att > 0 ? (pts / (2 * (fg.att + 0.44 * ft.att))) * 100 : null;
  const efg = fg.att > 0 ? ((fg.made + 0.5 * tp.made) / fg.att) * 100 : null;
  const eff = pts + reb + ast + stl + blk - (fg.att - fg.made) - (ft.att - ft.made) - tov;

  const teamMinutes = team?.teamMinutes || 0;
  const teamPossessions = team ? team.fga + 0.44 * team.fta + team.tov : 0;
  const usagePossessions = fg.att + 0.44 * ft.att + tov;
  const usg =
    minutes > 0 && teamMinutes > 0 && teamPossessions > 0
      ? ((usagePossessions * teamMinutes) / (minutes * teamPossessions)) * 100
      : null;
  const assistDenominator = minutes > 0 && teamMinutes > 0 ? (minutes / teamMinutes) * team.fgm - fg.made : 0;
  const astPct = assistDenominator > 0 ? (ast / assistDenominator) * 100 : null;
  const reboundChances = team && oppTotals ? team.reb + oppTotals.reb : 0;
  const rebPct =
    minutes > 0 && teamMinutes > 0 && reboundChances > 0
      ? ((reb * teamMinutes) / (minutes * reboundChances)) * 100
      : null;

  return { ts, efg, usg, astPct, rebPct, eff };
}

function teamTotals(summary, teamId) {
  if (!summary) return null;
  let cache = summaryTotalsCache.get(summary);
  if (!cache) {
    cache = new Map();
    summaryTotalsCache.set(summary, cache);
  }
  const key = String(teamId);
  if (cache.has(key)) return cache.get(key);

  const totals = { min: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, reb: 0, ast: 0, tov: 0, teamMinutes: 0 };
  const box = (summary?.boxscore?.players || []).find((item) => String(item.team?.id) === key);
  if (box) {
    const seen = new Set();
    for (const group of box.statistics || []) {
      for (const entry of group.athletes || []) {
        const id = String(entry.athlete?.id || '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const raw = {};
        (group.keys || []).forEach((statKey, index) => {
          raw[statKey] = entry.stats?.[index] ?? null;
        });
        const playerMinutes = parseMinutes(raw.minutes);
        if (playerMinutes <= 0) continue;
        const fg = parseSplit(raw['fieldGoalsMade-fieldGoalsAttempted']);
        const ft = parseSplit(raw['freeThrowsMade-freeThrowsAttempted']);
        totals.min += playerMinutes;
        totals.fgm += fg.made;
        totals.fga += fg.att;
        totals.ftm += ft.made;
        totals.fta += ft.att;
        totals.reb += num(raw.rebounds);
        totals.ast += num(raw.assists);
        totals.tov += num(raw.turnovers);
      }
    }
  }
  totals.teamMinutes = totals.min / 5;
  cache.set(key, totals);
  return totals;
}

function opponentTotals(summary, teamId) {
  const opponent = (summary?.boxscore?.players || []).find((item) => String(item.team?.id) !== String(teamId));
  return opponent ? teamTotals(summary, opponent.team?.id) : null;
}

/** 一票否决：命中返回原因文本，未命中返回 null */
function hotDisqualifier(stats) {
  if (!stats || stats.fga == null || stats.fga < HOT_DQ_MIN_ATTEMPTS) return null;
  if (stats.ts != null && stats.ts < HOT_DQ_MIN_TS) {
    return `出手 ${stats.fga} 次，真实命中率仅 ${stats.ts.toFixed(1)}%`;
  }
  if (stats.pts < HOT_DQ_MIN_POINTS) {
    return `出手 ${stats.fga} 次，仅得 ${stats.pts} 分`;
  }
  return null;
}

/** 列出这一场命中的全部维度（不做数量过滤），供「差几项」的判定复用 */
function collectHotReasons(stats, rules = HOT_RULES) {
  if (!stats || stats.minutes < HOT_MIN_MINUTES) return null;
  const reasons = rules.filter((rule) => rule.test(stats)).map((rule) => ({
    key: rule.key,
    label: rule.label,
  }));
  const doubleDigits = [stats.pts, stats.reb, stats.ast, stats.stl, stats.blk].filter(
    (value) => value >= 10
  ).length;
  if (doubleDigits >= 3) reasons.push({ key: 'td', label: '三双' });
  else if (doubleDigits >= 2) reasons.push({ key: 'dd', label: '两双' });
  return reasons;
}

function hotReasons(stats, options = {}) {
  // 赛季逐场数据（gamelog）没有正负值字段，统计时先按不含该维度的规则打分，
  // 差一项达标的场次再由 fetchPlusMinus 补查后定论（见 parseGamelog）。
  const rules = options.skipPlusMinus ? HOT_RULES_SEASON : HOT_RULES;
  const reasons = collectHotReasons(stats, rules);
  if (!reasons) return null;
  if (reasons.length < HOT_MIN_RULES) return null;
  // 达标项够了也要过否决这一关：效率熄火的场次不能靠防守数据凑成好球
  if (hotDisqualifier(stats)) return null;
  return reasons;
}

function hotRows() {
  return state.rows
    .filter((row) => row.hot?.length)
    .sort(
      (a, b) =>
        b.hot.length - a.hot.length ||
        b.stats.eff - a.stats.eff ||
        b.stats.pts - a.stats.pts
    );
}

function hotSummaryLine(row) {
  return `${row.stats.pts}分 ${row.stats.reb}板 ${row.stats.ast}助`;
}

function maybeAnnounceHot() {
  if (state.dateParam || !state.hasData || !state.slateDate || document.hidden) return;
  const rows = hotRows();
  if (!rows.length) return;

  const date = state.slateDate;
  const seen = new Set(hotAlertStore[date] || []);
  const fresh = rows.filter((row) => !seen.has(String(row.player.id)));
  if (!fresh.length) return;

  hotAlertStore[date] = [...seen, ...fresh.map((row) => String(row.player.id))];
  pruneHotAlertStore();
  saveHotAlertStore();

  el.hotBar.classList.add('flash');
  setTimeout(() => el.hotBar.classList.remove('flash'), 1400);

  const message =
    fresh.length === 1
      ? `${displayName(fresh[0].player)} 打得好：${hotSummaryLine(fresh[0])}`
      : `${fresh.length} 名球员打得好：${fresh
          .slice(0, 3)
          .map((row) => displayName(row.player))
          .join('、')}${fresh.length > 3 ? ' 等' : ''}`;
  showToast(message, '查看', scrollToHotBar, 'hot');
}

function scrollToHotBar() {
  if (state.view !== 'players') {
    state.view = 'players';
    saveView();
    render();
  }
  el.hotBar.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.hotBar.classList.add('flash');
  setTimeout(() => el.hotBar.classList.remove('flash'), 1400);
}

function loadHotAlertStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HOT_ALERT_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

function saveHotAlertStore() {
  try {
    localStorage.setItem(HOT_ALERT_KEY, JSON.stringify(hotAlertStore));
  } catch (error) {
    /* storage may be unavailable */
  }
  scheduleCloudSync();
}

function pruneHotAlertStore() {
  const dates = Object.keys(hotAlertStore).sort().slice(-8);
  const next = {};
  for (const date of dates) next[date] = hotAlertStore[date];
  hotAlertStore = next;
}

const SORT_LEADERS = {
  points: { label: '得分王', badge: '得分王', short: '分' },
  rebounds: { label: '篮板王', badge: '篮板王', short: '板' },
  assists: { label: '助攻王', badge: '助攻王', short: '助' },
  steals: { label: '抢断王', badge: '抢断王', short: '断' },
  blocks: { label: '盖帽王', badge: '盖帽王', short: '帽' },
  offRebounds: { label: '前场篮板王', badge: '前场篮板王', short: '前板' },
  minutes: { label: '出场时间最多', badge: '出场时间', short: '分钟' },
  efficiency: { label: '效率王', badge: '效率王', abbr: 'EFF' },
  ts: { label: '真实命中率第一', badge: '真实命中率', abbr: 'TS%', pct: true },
  efg: { label: '有效命中率第一', badge: '有效命中率', abbr: 'eFG%', pct: true },
  usg: { label: '使用率第一', badge: '使用率', abbr: 'USG%', pct: true },
  astPct: { label: '助攻率第一', badge: '助攻率', abbr: 'AST%', pct: true },
  rebPct: { label: '篮板率第一', badge: '篮板率', abbr: 'REB%', pct: true },
  plusMinus: { label: '正负值第一', badge: '正负值', abbr: '+/-', signed: true },
};

/** 排序字段的展示顺序：跟排序下拉保持一致，只保留有「王」定义的字段 */
const LEADER_ORDER = SORTS.map(([key]) => key).filter((key) => SORT_LEADERS[key]);

function leaderValueText(meta, value) {
  if (meta.pct) return `${fmtPct(value)}%`;
  if (meta.signed) return fmtSigned(value);
  return `${Math.round(value)}${meta.short || ''}`;
}

/** 每个排序字段各取第一名，返回 [{ key, label, badge, row, valueText }] */
function leadersForSorts(rows) {
  const played = rows.filter((row) => row.played && row.stats);
  if (!played.length) return [];

  const leaders = [];
  for (const key of LEADER_ORDER) {
    const meta = SORT_LEADERS[key];
    let best = null;
    let bestValue = null;

    for (const row of played) {
      const value = sortValue(row, key);
      if (value == null) continue;
      if (bestValue == null || value > bestValue || (value === bestValue && row.stats.pts > best.stats.pts)) {
        best = row;
        bestValue = value;
      }
    }
    if (!best) continue;

    leaders.push({
      key,
      label: meta.label,
      badge: meta.badge,
      abbr: meta.abbr || '',
      row: best,
      value: bestValue,
      valueText: leaderValueText(meta, bestValue),
    });
  }
  return leaders;
}

/** 当前排序字段的第一名（用于球员卡排名徽标） */
function leaderForSort(rows) {
  const key = SORT_LEADERS[state.sortKey] ? state.sortKey : 'points';
  return leadersForSorts(rows).find((item) => item.key === key) || null;
}

/** 用本场第一节到第二节的实际间隔，估算下一次节间休息时长 */
function sampleQuarterBreakMs(plays) {
  const bounds = new Map();
  for (const play of plays) {
    const period = play.period?.number;
    const wall = Date.parse(play.wallclock || '');
    if (!period || !Number.isFinite(wall)) continue;
    const entry = bounds.get(period);
    if (entry) {
      entry.first = Math.min(entry.first, wall);
      entry.last = Math.max(entry.last, wall);
    } else {
      bounds.set(period, { first: wall, last: wall });
    }
  }
  const first = bounds.get(1);
  const second = bounds.get(2);
  if (!first || !second) return 0;
  const gap = second.first - first.last;
  return gap >= BREAK_SAMPLE_MIN_MS && gap <= BREAK_SAMPLE_MAX_MS ? gap : 0;
}

function buildGameMeta(game, summary) {
  const summaryStatus = summary?.header?.competitions?.[0]?.status;
  const statusName = game.statusName || summaryStatus?.type?.name || '';
  const detail = game.detail || summaryStatus?.type?.detail || '';
  const live = game.state === 'live';
  const clockZero = live && Number.parseFloat(game.clock) === 0;
  const halftime =
    live &&
    (statusName === 'STATUS_HALFTIME' ||
      /halftime/i.test(detail) ||
      (game.period === 2 && clockZero));
  const endPeriod =
    live &&
    !halftime &&
    game.period !== 4 &&
    (statusName === 'STATUS_END_PERIOD' || (clockZero && (game.period === 1 || game.period === 3)));

  const plays = summary?.plays || [];
  const lastPlay = plays[plays.length - 1] || null;

  let halftimeEndsAt = 0;
  if (halftime) {
    const wall = Date.parse(lastPlay?.wallclock || '');
    if (Number.isFinite(wall)) {
      halftimeEndsAt = wall + HALFTIME_MS;
    } else {
      if (!halftimeSeen.has(game.id)) halftimeSeen.set(game.id, Date.now());
      halftimeEndsAt = halftimeSeen.get(game.id) + HALFTIME_MS;
    }
  } else {
    halftimeSeen.delete(game.id);
  }

  // 节间休息优先用本场实测的节间时长估算，没有样本时退回默认值
  const quarterBreakMs = sampleQuarterBreakMs(plays) || QUARTER_BREAK_MS;
  let breakEndsAt = 0;
  if (endPeriod) {
    const wall = Date.parse(lastPlay?.wallclock || '');
    if (Number.isFinite(wall)) {
      breakEndsAt = wall + quarterBreakMs;
    } else {
      if (!endPeriodSeen.has(game.id)) endPeriodSeen.set(game.id, Date.now());
      breakEndsAt = endPeriodSeen.get(game.id) + quarterBreakMs;
    }
  } else {
    endPeriodSeen.delete(game.id);
  }

  let timeoutTeamId = '';
  let timeoutUntil = 0;
  const lastType = lastPlay?.type?.text || '';
  const wall = Date.parse(lastPlay?.wallclock || '');
  if (/timeout/i.test(lastType) && !/challenge/i.test(lastType) && Number.isFinite(wall)) {
    timeoutUntil = wall + TIMEOUT_VISIBLE_MS;
    if (Date.now() < timeoutUntil) timeoutTeamId = String(lastPlay.team?.id || '');
  }
  if (halftime || endPeriod) {
    timeoutTeamId = '';
    timeoutUntil = 0;
  }

  return { halftime, endPeriod, halftimeEndsAt, breakEndsAt, timeoutTeamId, timeoutUntil };
}

function timeoutRemaining(until) {
  if (!until) return 0;
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

function timeoutStatusText(until) {
  const remaining = timeoutRemaining(until);
  return remaining > 0 ? `暂停 · ${formatCountdown(remaining)}` : '暂停';
}

function breakRemaining(endsAt) {
  if (!endsAt) return 0;
  return Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
}

function breakStatusText(endsAt, period, short = false) {
  const remaining = breakRemaining(endsAt);
  const label = period ? `${periodLabel(period)}结束` : '节间休息';
  if (short) return remaining > 0 ? `${label} ${formatCountdown(remaining)}` : `${label} 即将开始`;
  return remaining > 0 ? `${label} · ${formatCountdown(remaining)} 后继续` : `${label} · 即将开始`;
}

function liveStatusText(game, meta) {
  if (meta?.halftime) return halftimeStatusText(meta.halftimeEndsAt);
  if (meta?.endPeriod) return breakStatusText(meta.breakEndsAt, game.period);
  const clock = game.clock ? ` · 剩 ${game.clock}` : '';
  return `${periodLabel(game.period)}${clock}`;
}

function halftimeRemaining(endsAt) {
  if (!endsAt) return 0;
  return Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
}

function formatCountdown(totalSeconds) {
  const safe = Math.max(0, totalSeconds);
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

function halftimeStatusText(endsAt) {
  const remaining = halftimeRemaining(endsAt);
  return remaining > 0 ? `中场 · ${formatCountdown(remaining)} 后继续` : '中场 · 即将开始';
}

function shortHalftimeText(endsAt) {
  const remaining = halftimeRemaining(endsAt);
  return remaining > 0 ? `中场 ${formatCountdown(remaining)}` : '中场 即将开始';
}

function updateLiveClocks() {
  const now = Date.now();
  document.querySelectorAll('[data-timeout-until]').forEach((node) => {
    const until = Number(node.dataset.timeoutUntil);
    if (now >= until) {
      node.hidden = true;
      return;
    }
    const remaining = timeoutRemaining(until);
    const text = node.querySelector('.ts-text');
    if (text) text.textContent = timeoutStatusText(until);
    else node.textContent = `暂停 · ${formatCountdown(remaining)}`;
  });
  document.querySelectorAll('[data-break-ends]').forEach((node) => {
    const endsAt = Number(node.dataset.breakEnds);
    const period = Number(node.dataset.breakPeriod) || null;
    node.textContent = breakStatusText(endsAt, period, node.dataset.breakMode === 'short');
  });
  document.querySelectorAll('[data-halftime-ends]').forEach((node) => {
    const endsAt = Number(node.dataset.halftimeEnds);
    node.textContent =
      node.dataset.halftimeMode === 'short'
        ? shortHalftimeText(endsAt)
        : halftimeStatusText(endsAt);
  });
}

/* ---------- render ---------- */

function render() {
  renderDate();
  renderView();
  renderUpdated();
  if (state.view === 'teams') {
    renderTeamSummary();
    renderTeamFilters();
    renderTeamGrid();
  } else {
    renderSummary();
    renderHotBar();
    renderFilters();
    renderGrid();
  }
  if (el.rosterModal && !el.rosterModal.hidden) renderRosterModal();
}

function renderView() {
  el.viewTabs.querySelectorAll('[data-view]').forEach((button) => {
    const active = button.dataset.view === state.view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  el.playersView.hidden = state.view !== 'players';
  el.teamsView.hidden = state.view !== 'teams';
  document.body.classList.toggle('view-teams', state.view === 'teams');

  const counts = {
    teams: state.hasData ? `${state.games.length} 场` : '—',
    players: `${state.players.length} 人`,
  };
  el.viewTabs.querySelectorAll('[data-view-count]').forEach((node) => {
    node.textContent = counts[node.dataset.viewCount] ?? '';
  });
}

function switchView(view) {
  if (view !== 'teams' && view !== 'players') return;
  if (state.view === view) return;
  state.view = view;
  saveView();
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function loadView() {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    return saved === 'teams' || saved === 'players' ? saved : 'players';
  } catch (error) {
    return 'players';
  }
}

function saveView() {
  try {
    localStorage.setItem(VIEW_KEY, state.view);
  } catch (error) {
    /* storage may be unavailable */
  }
  scheduleCloudSync();
}

function renderDate() {
  if (!state.slateDate) {
    el.dateLabel.textContent = '加载中…';
    el.dateHint.textContent = '美东赛程日';
    el.todayDate.disabled = true;
    return;
  }
  const date = new Date(state.slateDate + 'T12:00:00Z');
  el.dateLabel.textContent = `${date.getUTCMonth() + 1}月${date.getUTCDate()}日 ${WEEKDAYS[date.getUTCDay()]}`;
  el.dateHint.textContent = state.dateParam ? '美东赛程日' : '今日 · 美东';
  el.todayDate.disabled = !state.dateParam;
}

function renderSummary() {
  if (!state.hasData) {
    const snap = activeSnapshot();
    if (snap && snap.summaryBar) {
      el.summaryBar.innerHTML = snap.summaryBar;
      return;
    }
    el.summaryBar.innerHTML = '';
    return;
  }

  const rows = state.rows;
  const leaders = leadersForSorts(rows);
  const dayWord = state.dateParam ? '当日' : '今日';
  // 每 10 秒刷新会重建这一段，保留横向滚动位置，避免看后面的字段时被弹回最左
  const prevScroll = el.summaryBar.querySelector('.sl-track')?.scrollLeft || 0;

  el.summaryBar.innerHTML = leaders.length
    ? `<div class="sum-leaders" aria-label="${dayWord}各项数据第一">
        <div class="sl-head">
          <span class="sl-title">${dayWord}榜首</span>
          <span class="sl-count">${leaders.length} 项</span>
          <span class="sl-hint">点卡片切换排序</span>
        </div>
        <div class="sl-track">${leaders.map(leaderChipHTML).join('')}</div>
      </div>`
    : `<div class="sum-note">${
        rows.length ? `${dayWord}暂无关注球员上场` : '还没有关注球员，点右上角添加'
      }</div>`;

  const track = el.summaryBar.querySelector('.sl-track');
  if (track && prevScroll) track.scrollLeft = prevScroll;
}

function leaderChipHTML(leader) {
  const player = leader.row.player;
  const team = leader.row.team || state.teams.get(String(player.teamId));
  const abbr = team?.abbr || player.teamAbbr || '';
  const active = leader.key === state.sortKey;
  const name = displayName(player);
  return `<button type="button" class="sl-chip${active ? ' active' : ''}" data-leader-sort="${esc(
    leader.key
  )}" title="${esc(`${leader.label}：${name} ${leader.valueText}`)}">
    <span class="sl-avatar">
      <span class="sl-avatar-fallback">${esc(initials(player))}</span>
      <img src="${esc(playerHeadshot(player))}" alt="" loading="lazy" onerror="this.remove()">
    </span>
    <span class="sl-body">
      <span class="sl-top">
        <span class="sl-badge">${esc(leader.badge)}${
          leader.abbr ? `<i>${esc(leader.abbr)}</i>` : ''
        }</span>
        <span class="sl-value">${esc(leader.valueText)}</span>
      </span>
      <span class="sl-name"><b>${esc(name)}</b>${abbr ? `<em>${esc(abbr)}</em>` : ''}</span>
    </span>
  </button>`;
}

function renderHotBar() {
  if (!state.hasData) {
    el.hotBar.hidden = true;
    el.hotBar.innerHTML = '';
    return;
  }

  el.hotBar.hidden = false;
  const rows = hotRows();
  const dayWord = state.dateParam ? '当日' : '今日';
  const cards = rows
    .map((row) => {
      const player = row.player;
      const abbr = row.team?.abbr || player.teamAbbr || '';
      const color = row.team?.color || '#ff7a1a';
      return `<button type="button" class="hot-card" data-hot-player="${esc(player.id)}" aria-label="查看 ${esc(
        displayName(player)
      )} 的数据">
        <span class="hot-avatar" style="--team-color:${color}">
          <span class="hot-avatar-fallback">${esc(initials(player))}</span>
          <img src="${esc(playerHeadshot(player))}" alt="" loading="lazy" onerror="this.remove()">
        </span>
        <span class="hot-info">
          <span class="hot-name"><span class="hot-name-text">${esc(displayName(player))}</span>${
            abbr ? `<em>${esc(abbr)}</em>` : ''
          }</span>
          <span class="hot-line">${esc(hotSummaryLine(row))}${
            row.stats.ts != null ? ` · TS ${row.stats.ts.toFixed(1)}%` : ''
          }</span>
          <span class="hot-tags">${row.hot
            .slice(0, 4)
            .map((reason) => `<span class="hot-tag">${esc(reason.label)}</span>`)
            .join('')}</span>
        </span>
      </button>`;
    })
    .join('');

  el.hotBar.innerHTML = `
    <div class="hotbar-head">
      <span class="hotbar-title">打得好</span>
      <span class="hotbar-count">${rows.length}</span>
      <span class="hotbar-sub" title="${esc(HOT_CRITERIA_TEXT)}">上场≥${HOT_MIN_MINUTES}分钟 · 任意${HOT_MIN_RULES}项：15分/8板/6助/3断帽/TS60%/正负+10/两双</span>
    </div>
    ${
      rows.length
        ? `<div class="hotbar-track">${cards}</div>`
        : `<div class="hotbar-empty">${dayWord}还没有球员达到门槛，数据每 ${REFRESH_SECONDS} 秒更新。</div>`
    }
  `;
}

/* ---------- teams view ---------- */

function watchedTeamSet() {
  return new Set(state.players.map((player) => String(player.teamId)).filter(Boolean));
}

function isWatchedGame(game, watched = watchedTeamSet()) {
  return game.competitors.some((team) => watched.has(team.teamId));
}

function gameCounts() {
  const watched = watchedTeamSet();
  const counts = { all: state.games.length, live: 0, pre: 0, final: 0, watch: 0 };
  for (const game of state.games) {
    if (counts[game.state] != null) counts[game.state] += 1;
    if (isWatchedGame(game, watched)) counts.watch += 1;
  }
  return counts;
}

function renderTeamSummary() {
  if (!state.hasData) {
    el.teamSummary.innerHTML = `<div class="team-sum-note">正在获取${state.dateParam ? '当日' : '今日'}比赛…</div>`;
    return;
  }

  const counts = gameCounts();
  const dayWord = state.dateParam ? '当日' : '今日';
  el.teamSummary.innerHTML = `
    <div class="team-sum-blocks">
      <div class="team-sum-block"><b>${counts.all}</b><span>场比赛</span></div>
      <div class="team-sum-block live"><b>${counts.live}</b><span>场进行中</span></div>
      <div class="team-sum-block"><b>${counts.final}</b><span>场已结束</span></div>
      <div class="team-sum-block watch"><b>${counts.watch}</b><span>场有你关注的球员</span></div>
    </div>
    <div class="team-sum-note">${dayWord}赛程 · 球队技术统计每 ${REFRESH_SECONDS} 秒更新</div>
  `;
}

function renderTeamFilters() {
  if (!['all', 'live', 'pre', 'final', 'watch'].includes(state.gameFilter)) state.gameFilter = 'all';
  const counts = gameCounts();
  el.gameFilter.querySelectorAll('[data-game-filter]').forEach((button) => {
    const key = button.dataset.gameFilter;
    button.classList.toggle('active', key === state.gameFilter);
    const count = button.querySelector('.count');
    if (count) count.textContent = state.hasData ? String(counts[key] || 0) : '–';
  });
}

function visibleGames() {
  const watched = watchedTeamSet();
  const games = state.games.filter((game) => {
    if (state.gameFilter === 'watch') return isWatchedGame(game, watched);
    if (state.gameFilter !== 'all' && game.state !== state.gameFilter) return false;
    return true;
  });
  const order = { live: 0, pre: 1, final: 2 };
  return games.sort(
    (a, b) => (order[a.state] ?? 3) - (order[b.state] ?? 3) || new Date(a.date) - new Date(b.date)
  );
}

function renderTeamGrid() {
  const snap = !state.hasData ? activeSnapshot() : null;
  if (snap && snap.teamGrid) {
    el.teamGrid.innerHTML = snap.teamGrid;
    el.teamEmpty.hidden = true;
    return;
  }

  if (!state.hasData) {
    if (state.loadError) {
      el.teamGrid.innerHTML = '';
      el.teamEmpty.hidden = false;
      el.teamEmpty.innerHTML = `${emptyIcon()}
        <h3>比赛数据加载失败</h3>
        <p>${esc(state.loadError.message || '网络异常，请稍后重试')}</p>
        <button class="primary-btn" data-game-retry>重新加载</button>`;
    } else {
      el.teamGrid.innerHTML = teamSkeletonHTML(2);
      el.teamEmpty.hidden = true;
    }
    return;
  }

  const games = visibleGames();
  if (!games.length) {
    el.teamGrid.innerHTML = '';
    el.teamEmpty.hidden = false;
    const filtered = state.gameFilter !== 'all';
    el.teamEmpty.innerHTML = `${emptyIcon()}
      <h3>${filtered ? '当前筛选下没有比赛' : '该比赛日没有 NBA 比赛'}</h3>
      <p>${filtered ? '换个筛选条件看看。' : '换一天看看，或者等待赛程公布。'}</p>
      ${filtered ? '<button class="text-btn" data-reset-game-filter>清除筛选</button>' : ''}`;
    return;
  }

  el.teamEmpty.hidden = true;
  const rowsByGame = new Map();
  for (const row of state.rows) {
    if (!row.game) continue;
    if (!rowsByGame.has(row.game.id)) rowsByGame.set(row.game.id, []);
    rowsByGame.get(row.game.id).push(row);
  }
  const watched = watchedTeamSet();
  el.teamGrid.innerHTML = games
    .map((game) => teamGameHTML(game, rowsByGame.get(game.id) || [], watched))
    .join('');
}

function teamGameHTML(game, rows, watched) {
  const away = game.competitors.find((team) => team.homeAway === 'away') || game.competitors[1];
  const home = game.competitors.find((team) => team.homeAway === 'home') || game.competitors[0];
  if (!away || !home) return '';

  const meta = state.gameMeta.get(game.id) || {};
  const hasWatch = isWatchedGame(game, watched);
  const awayColor = state.teams.get(away.teamId)?.color || '#3b82f6';
  const homeColor = state.teams.get(home.teamId)?.color || '#ff7a1a';
  const summary = state.summaries.get(game.id);
  const awayStats = summary ? extractTeamStats(summary, away.teamId) : null;
  const homeStats = summary ? extractTeamStats(summary, home.teamId) : null;
  const leaderId = leadingTeamId(game);

  const teamRow = (team, side) => {
    const info = state.teams.get(team.teamId) || {};
    const name = cnTeam(team.abbr) || info.short || team.short || team.abbr;
    const timeout =
      meta.timeoutTeamId === team.teamId && Date.now() < meta.timeoutUntil
        ? `<span class="timeout-tag" data-timeout-until="${meta.timeoutUntil}">${esc(timeoutStatusText(meta.timeoutUntil))}</span>`
        : '';
    const score =
      game.state === 'pre'
        ? '<span class="team-score">—</span>'
        : `<span class="team-score${
            leaderId ? (leaderId === team.teamId ? ' leading' : ' trailing') : ''
          }">${esc(team.score)}</span>`;
    return `<div class="team-row ${side}">
      <span class="team-side">${side === 'away' ? '客' : '主'}</span>
      <img class="team-logo" src="${esc(team.logo || teamLogo(team.abbr))}" alt="" loading="lazy" onerror="this.remove()">
      <div class="team-id" title="${esc(team.name)}">
        <b>${esc(name)}</b>
        <span>${esc(team.abbr)}${team.record ? ' · ' + esc(team.record) : ''}</span>
      </div>
      ${timeout}
      ${score}
    </div>`;
  };

  const compare =
    game.state === 'pre'
      ? ''
      : awayStats && homeStats
        ? teamCompareHTML(away, home, awayStats, homeStats, awayColor, homeColor)
        : `<div class="game-stats-pending">${esc(summaryPendingText(game.id))}</div>`;

  return `<article class="game-card ${game.state}${hasWatch ? ' has-watch' : ''}" style="--away-color:${esc(
    awayColor
  )};--home-color:${esc(homeColor)}">
    <div class="game-card-head">
      <div class="game-head-status">
        ${teamGameStatusHTML(game, meta)}
        ${hasWatch ? '<span class="game-watch-badge">关注</span>' : ''}
      </div>
      ${game.venue ? `<span class="game-venue" title="${esc(game.venue)}">${esc(game.venue)}</span>` : ''}
    </div>
    ${teamRow(away, 'away')}
    ${teamRow(home, 'home')}
    ${compare}
    ${teamWatchHTML(game, rows)}
    ${teamRosterButtonHTML(game, rows, summary)}
  </article>`;
}

function leadingTeamId(game) {
  if (game.state === 'pre') return '';
  const [a, b] = game.competitors;
  if (!a || !b) return '';
  const aScore = Number(a.score);
  const bScore = Number(b.score);
  if (!Number.isFinite(aScore) || !Number.isFinite(bScore) || aScore === bScore) return '';
  return aScore > bScore ? a.teamId : b.teamId;
}

function teamGameStatusHTML(game, meta) {
  if (game.state === 'live' && meta.halftime) {
    return `<span class="game-state-pill halftime" data-halftime-ends="${meta.halftimeEndsAt}">${esc(
      halftimeStatusText(meta.halftimeEndsAt)
    )}</span>`;
  }
  if (game.state === 'live' && meta.endPeriod) {
    return `<span class="game-state-pill break" data-break-ends="${meta.breakEndsAt || 0}" data-break-period="${game.period}">${esc(
      breakStatusText(meta.breakEndsAt, game.period)
    )}</span>`;
  }
  if (game.state === 'live') {
    const clock = game.clock ? ` · 剩 ${game.clock}` : '';
    return `<span class="game-state-pill live">${esc(periodLabel(game.period))}${esc(clock)}</span>`;
  }
  if (game.state === 'final') return '<span class="game-state-pill final">已结束</span>';
  return `<span class="game-state-pill pre">未开始 · ${esc(formatTip(game.date))}</span>`;
}

function teamCompareHTML(away, home, awayStats, homeStats, awayColor, homeColor) {
  const rows = [
    {
      label: 'FG%',
      a: awayStats.fgPct,
      b: homeStats.fgPct,
      suffix: '%',
      hintA: `${away.abbr} 命中 ${awayStats.fg.made}-${awayStats.fg.att}`,
      hintB: `${home.abbr} 命中 ${homeStats.fg.made}-${homeStats.fg.att}`,
    },
    {
      label: '3P%',
      a: awayStats.tpPct,
      b: homeStats.tpPct,
      suffix: '%',
      hintA: `${away.abbr} 三分 ${awayStats.tp.made}-${awayStats.tp.att}`,
      hintB: `${home.abbr} 三分 ${homeStats.tp.made}-${homeStats.tp.att}`,
    },
    {
      label: 'FT%',
      a: awayStats.ftPct,
      b: homeStats.ftPct,
      suffix: '%',
      hintA: `${away.abbr} 罚球 ${awayStats.ft.made}-${awayStats.ft.att}`,
      hintB: `${home.abbr} 罚球 ${homeStats.ft.made}-${homeStats.ft.att}`,
    },
    { label: '篮板', a: awayStats.reb, b: homeStats.reb },
    { label: '助攻', a: awayStats.ast, b: homeStats.ast },
    { label: '失误', a: awayStats.tov, b: homeStats.tov, lowerBetter: true },
  ];

  const betterSide = (row) => {
    if (row.a == null || row.b == null || row.a === row.b) return '';
    return (row.lowerBetter ? row.a < row.b : row.a > row.b) ? 'a' : 'b';
  };
  const cell = (row, side) => {
    const value = side === 'a' ? row.a : row.b;
    if (value == null) return '<span class="gs-val">—</span>';
    const hint = side === 'a' ? row.hintA : row.hintB;
    return `<span class="gs-val${betterSide(row) === side ? ' better' : ''}"${
      hint ? ` title="${esc(hint)}"` : ''
    }>${fmtCompact(value, row.suffix)}</span>`;
  };

  return `<div class="game-stats">
    <div class="gs-row gs-head">
      <span class="gs-team"></span>
      ${rows.map((row) => `<span>${row.label}</span>`).join('')}
    </div>
    <div class="gs-row">
      <span class="gs-team"><i style="background:${esc(awayColor)}"></i>${esc(away.abbr)}</span>
      ${rows.map((row) => cell(row, 'a')).join('')}
    </div>
    <div class="gs-row">
      <span class="gs-team"><i style="background:${esc(homeColor)}"></i>${esc(home.abbr)}</span>
      ${rows.map((row) => cell(row, 'b')).join('')}
    </div>
  </div>
  <div class="game-stat-notes">
    <span>禁区 ${awayStats.pitp} : ${homeStats.pitp}</span>
    <span>快攻 ${awayStats.fastBreak} : ${homeStats.fastBreak}</span>
  </div>`;
}

function teamWatchHTML(game, rows) {
  if (!rows.length) return '';
  const sorted = [...rows].sort(
    (a, b) => Number(b.played) - Number(a.played) || (b.stats?.pts || 0) - (a.stats?.pts || 0)
  );
  const chips = sorted
    .slice(0, 3)
    .map((row) => {
      const detail = playerInlineDetail(row);
      return `<button type="button" class="watch-chip${row.played ? ' played' : ''}" data-team-player="${esc(
        row.player.id
      )}" title="查看 ${esc(displayName(row.player))} 的球员数据"><b>${esc(
        displayName(row.player)
      )}</b><span>${esc(detail)}</span></button>`;
    })
    .join('');
  return `<div class="game-watch">
    <span class="game-watch-label">关注</span>
    <div class="game-watch-list">${chips}${
      sorted.length > 3
        ? `<button type="button" class="watch-more" data-open-roster="${esc(game.id)}" title="查看全部球员">+${
            sorted.length - 3
          }</button>`
        : ''
    }</div>
  </div>`;
}

function teamRosterButtonHTML(game, rows, summary) {
  if (game.state === 'pre') return '';
  const others = rosterOthers(game, rows, summary);
  const total = rows.length + others.length;
  if (!total) return '';
  return `<button type="button" class="roster-open" data-open-roster="${esc(
    game.id
  )}" title="点击查看两队全部球员">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
    <span class="roster-open-label">全部球员</span>
    <span class="roster-open-count">${total} 人</span>
    <svg class="roster-open-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
  </button>`;
}

function rosterOthers(game, rows, summary) {
  const followedIds = new Set(rows.map((row) => String(row.player.id)));
  return gameRoster(summary, game)
    .filter((entry) => !followedIds.has(entry.id))
    .sort((a, b) => b.minutes - a.minutes || b.pts - a.pts || a.name.localeCompare(b.name, 'en'));
}

function rosterModalGame() {
  return state.games.find((game) => game.id === rosterModalGameId) || null;
}

function openRosterModal(gameId, trigger = null) {
  const game = state.games.find((item) => String(item.id) === String(gameId));
  if (!game || game.state === 'pre') return;
  rosterModalGameId = game.id;
  rosterModalTrigger = trigger;
  renderRosterModal();
  el.rosterModal.hidden = false;
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => {
    if (!el.rosterModal.hidden) el.rosterModalClose.focus();
  });
}

function closeRosterModal({ restoreFocus = true } = {}) {
  if (el.rosterModal.hidden) return;
  const gameId = rosterModalGameId;
  const trigger = rosterModalTrigger;
  el.rosterModal.hidden = true;
  el.rosterModalBody.innerHTML = '';
  rosterModalGameId = null;
  rosterModalTrigger = null;
  if (!el.modal || el.modal.hidden) document.body.classList.remove('modal-open');
  if (!restoreFocus || !gameId || state.view !== 'teams') return;
  if (trigger?.isConnected) {
    trigger.focus({ preventScroll: true });
    return;
  }
  const fallback =
    el.teamGrid.querySelector(`.roster-open[data-open-roster="${gameId}"]`) ||
    el.teamGrid.querySelector(`[data-open-roster="${gameId}"]`);
  fallback?.focus({ preventScroll: true });
}

/* ---------- 球员逐场记录弹窗 ---------- */

const HOT_KEY_SHORT = {
  pts: '得分',
  reb: '篮板',
  ast: '助攻',
  stocks: '断帽',
  ts: '效率',
  pm: '正负',
  dd: '两双',
  td: '三双',
};

let playerModalTrigger = null;

function openPlayerModal(playerId) {
  const player = state.players.find((p) => String(p.id) === String(playerId));
  if (!player) return;
  const stats = hotStatsFor(playerId);
  const teamName = cnTeam(player.teamAbbr) || player.teamAbbr || '';
  const metaParts = [];
  if (teamName) metaParts.push(teamName);
  if (stats) metaParts.push(`赛季 ${stats.hotGames}/${stats.games} 场达标`);
  metaParts.push(`阈值 ${state.hotThreshold} 场`);

  el.playerModalTitle.textContent = player.name;
  el.playerModalMeta.textContent = metaParts.join(' · ');
  el.playerModalBody.innerHTML = playerLogHTML(stats);
  playerModalTrigger = document.activeElement;
  el.playerModal.hidden = false;
  document.body.classList.add('modal-open');
  el.playerModalClose.focus({ preventScroll: true });
}

function closePlayerModal() {
  if (el.playerModal.hidden) return;
  el.playerModal.hidden = true;
  el.playerModalBody.innerHTML = '';
  const trigger = playerModalTrigger;
  playerModalTrigger = null;
  if (el.modal.hidden && el.rosterModal.hidden && el.authModal.hidden) {
    document.body.classList.remove('modal-open');
  }
  if (trigger?.isConnected) trigger.focus({ preventScroll: true });
}

function playerLogHTML(stats) {
  if (!stats || !Array.isArray(stats.log) || !stats.log.length) {
    const hint = state.hotStatsLoading
      ? '正在拉取本赛季逐场数据，稍等一下…'
      : '暂无逐场数据（本赛季还没出场，或数据拉取失败）';
    return `<p class="plog-empty">${esc(hint)}</p>`;
  }

  const head = `<div class="plog-row plog-head">
    <span>日期</span><span>对手</span><span>比分</span><span>分/板/助</span><span>断+帽</span><span>分钟</span><span>判定</span>
  </div>`;

  const body = stats.log
    .map((game) => {
      const date = game.d ? game.d.slice(5) : '—';
      const opp = `${game.v === '@' ? '@' : 'vs'} ${game.o || '—'}`;
      const score = game.sc || '—';
      const res =
        game.r === 'W'
          ? '<i class="plog-res win">胜</i>'
          : game.r === 'L'
            ? '<i class="plog-res loss">负</i>'
            : '';
      const line = `<b>${game.pts}</b>/${game.reb}/${game.ast}`;
      const def = `${game.stl}+${game.blk}`;
      const tsText = game.ts == null ? '—' : game.ts.toFixed(1);
      let verdict;
      if (game.hot) {
        const why = (game.k || []).map((key) => HOT_KEY_SHORT[key] || key).join('、');
        verdict = `<span class="plog-tag hot" title="${esc('达标维度：' + why)}">打得好</span>`;
      } else if (game.dq) {
        verdict = `<span class="plog-tag dq" title="${esc('一票否决：' + game.dq)}">不计</span>`;
      } else {
        verdict = '<span class="plog-tag none">—</span>';
      }
      return `<div class="plog-row${game.hot ? ' is-hot' : ''}">
        <span class="plog-date">${esc(date)}</span>
        <span class="plog-opp">${esc(opp)}</span>
        <span class="plog-score">${esc(score)}${res}</span>
        <span class="plog-line">${line}</span>
        <span class="plog-def">${def}</span>
        <span class="plog-min" title="真实命中率 ${esc(tsText)}%">${game.min}</span>
        <span>${verdict}</span>
      </div>`;
    })
    .join('');

  return `<p class="plog-summary">共 <b>${stats.games}</b> 场，其中 <b class="hl">${stats.hotGames}</b> 场达到打得好门槛</p>
    <div class="plog-list">${head}${body}</div>`;
}

function rosterGameStatus(game) {  const meta = state.gameMeta.get(game.id) || {};
  if (game.state === 'live' && meta.halftime) return halftimeStatusText(meta.halftimeEndsAt);
  if (game.state === 'live' && meta.endPeriod) return breakStatusText(meta.breakEndsAt, game.period);
  if (game.state === 'live') return `${periodLabel(game.period)}${game.clock ? ' 剩 ' + game.clock : ''}`;
  if (game.state === 'final') return '已结束';
  return `未开始 · ${formatTip(game.date)}`;
}

function renderRosterModal() {
  const game = rosterModalGame();
  if (!game) {
    closeRosterModal({ restoreFocus: false });
    return;
  }

  const away = game.competitors.find((team) => team.homeAway === 'away') || game.competitors[1];
  const home = game.competitors.find((team) => team.homeAway === 'home') || game.competitors[0];
  if (!away || !home) return;
  const teamName = (team) => cnTeam(team.abbr) || state.teams.get(team.teamId)?.short || team.abbr;

  const rows = state.rows.filter((row) => row.game && row.game.id === game.id);
  const followed = [...rows].sort(
    (a, b) =>
      Number(b.played) - Number(a.played) ||
      (b.stats?.minutes || 0) - (a.stats?.minutes || 0) ||
      (b.stats?.pts || 0) - (a.stats?.pts || 0)
  );
  const others = rosterOthers(game, rows, state.summaries.get(game.id));
  const total = followed.length + others.length;
  const score = game.state === 'pre' ? '未开始' : `${away.score} : ${home.score}`;

  el.rosterModalTitle.textContent = `${teamName(away)} vs ${teamName(home)}`;
  el.rosterModalMeta.textContent = [score, rosterGameStatus(game), `${total} 人`].join(' · ');

  const teamBlockHTML = (team) => {
    const teamId = String(team.teamId);
    const teamRows = followed.filter((row) => String(row.player.teamId) === teamId);
    const teamOthers = others.filter((entry) => entry.teamId === teamId);
    if (!teamRows.length && !teamOthers.length) return '';

    const teamDnp = teamRows.some((row) => !row.played);
    const watchedGroup = teamRows.length
      ? `<div class="roster-group watched">
          <div class="roster-group-head">我关注的 <b>${teamRows.length}</b>${
            teamDnp ? '<span class="roster-group-note">含未上场</span>' : ''
          }</div>
          ${teamRows.map(rosterFollowedHTML).join('')}
        </div>`
      : '';
    const othersGroup = teamOthers.length
      ? `<div class="roster-group">
          <div class="roster-group-head">其他上场球员 <b>${teamOthers.length}</b></div>
          ${teamOthers.map(rosterOtherHTML).join('')}
        </div>`
      : '';

    const info = state.teams.get(teamId) || {};
    const logo = team.logo || info.logo || teamLogo(team.abbr);
    return `<section class="roster-team-block" style="--team-color:${esc(info.color || '#ff7a1a')}">
      <div class="roster-team-head">
        <img class="roster-team-logo" src="${esc(logo)}" alt="" loading="lazy" onerror="this.remove()">
        <div class="roster-team-id">
          <b>${esc(teamName(team))}</b>
          <span>${team.homeAway === 'away' ? '客' : '主'} · ${esc(team.abbr)}</span>
        </div>
        <span class="roster-team-score">${esc(team.score)}</span>
      </div>
      ${watchedGroup}${othersGroup}
    </section>`;
  };

  const scrollTop = el.rosterModalBody.scrollTop;
  el.rosterModalBody.innerHTML =
    [away, home].map(teamBlockHTML).join('') ||
    '<div class="search-state">该场技术统计尚未同步，请稍后刷新。</div>';
  el.rosterModalBody.scrollTop = scrollTop;
}

function gameRoster(summary, game) {
  const roster = [];
  if (!summary) return roster;
  const boxes = summary.boxscore?.players || [];

  for (const team of game.competitors) {
    const box = boxes.find((item) => String(item.team?.id) === team.teamId);
    if (!box) continue;
    const color = state.teams.get(team.teamId)?.color || '#ff7a1a';
    const seen = new Set();

    for (const group of box.statistics || []) {
      for (const entry of group.athletes || []) {
        const id = String(entry.athlete?.id || '');
        if (!id || seen.has(id)) continue;
        seen.add(id);

        const raw = {};
        (group.keys || []).forEach((key, index) => {
          raw[key] = entry.stats?.[index] ?? null;
        });
        const minutes = parseMinutes(raw.minutes);
        if (minutes <= 0) continue;

        roster.push({
          id,
          name: entry.athlete?.displayName || entry.athlete?.shortName || '',
          teamId: team.teamId,
          abbr: team.abbr,
          color,
          minutes,
          pts: num(raw.points),
          reb: num(raw.rebounds),
          ast: num(raw.assists),
        });
      }
    }
  }
  return roster;
}

function rosterFollowedHTML(row) {
  const team = row.team || state.teams.get(String(row.player.teamId));
  const abbr = team?.abbr || row.player.teamAbbr || '';
  const color = team?.color || '#ff7a1a';
  const name = displayName(row.player);
  const liveTag =
    row.state === 'live' && row.played
      ? `<span class="roster-live ${row.onCourt ? 'on' : 'off'}">${row.onCourt ? '在场' : '休息'}</span>`
      : '';

  let detail;
  if (row.played) {
    detail = `${Math.round(row.stats.minutes)}分钟 · ${row.stats.pts}分 ${row.stats.reb}板 ${row.stats.ast}助`;
  } else if (row.state === 'bench') {
    detail = row.reason ? `未上场 · ${row.reason}` : '未上场';
  } else if (row.state === 'pre') {
    detail = '未开始';
  } else {
    detail = '同步中';
  }

  return `<button type="button" class="roster-row is-followed" data-team-player="${esc(
    row.player.id
  )}" title="查看 ${esc(name)} 的球员数据">
    <span class="roster-team" style="--team-color:${esc(color)}">${esc(abbr)}</span>
    <span class="roster-name"><span class="roster-name-text">${esc(name)}</span>${liveTag}</span>
    <span class="roster-stat">${esc(detail)}</span>
  </button>`;
}

function rosterOtherHTML(entry) {
  const name = playerNameZh(entry.name) || entry.name;
  return `<div class="roster-row">
    <span class="roster-team" style="--team-color:${esc(entry.color)}">${esc(entry.abbr)}</span>
    <span class="roster-name" title="${esc(entry.name)}"><span class="roster-name-text">${esc(
      name
    )}</span></span>
    <span class="roster-stat">${Math.round(entry.minutes)}分钟 · ${entry.pts}分 ${entry.reb}板 ${entry.ast}助</span>
  </div>`;
}

function playerInlineDetail(row) {
  if (row.played) return `${row.stats.pts}分 ${row.stats.reb}板 ${row.stats.ast}助`;
  if (row.state === 'bench') return '未上场';
  if (row.state === 'pre') return '未开始';
  if (row.state === 'unknown') return '同步中';
  return row.statusLabel;
}

function fmtCompact(value, suffix = '') {
  if (value == null) return '—';
  return `${Math.round(value * 10) / 10}${suffix}`;
}

function teamSkeletonHTML(count) {
  return Array.from(
    { length: count },
    () => `<div class="game-card skeleton" aria-hidden="true">
      <div class="sk sk-line w40"></div>
      <div class="sk sk-team"></div>
      <div class="sk sk-team"></div>
      <div class="sk sk-block"></div>
    </div>`
  ).join('');
}

function renderFilters() {
  const counts = {
    all: state.rows.length,
    played: state.rows.filter((row) => row.played).length,
    onCourt: state.rows.filter((row) => row.state === 'live' && row.onCourt === true).length,
    resting: state.rows.filter((row) => row.state === 'live' && row.onCourt === false).length,
    hot: state.rows.filter((row) => row.hot?.length).length,
    bag: state.rows.filter((row) => playerGroup(row.player) === 'bag').length,
    stable: stableRows().length,
    flash: flashRows().length,
    bench: state.rows.filter((row) => row.state === 'bench').length,
    idle: state.rows.filter((row) => row.state === 'idle').length,
  };

  el.statusFilter.querySelectorAll('[data-status]').forEach((button) => {
    const key = button.dataset.status;
    button.classList.toggle('active', key === state.filterStatus);
    const count = button.querySelector('.count');
    if (count) count.textContent = state.hasData ? String(counts[key] || 0) : '–';
  });

  const teamMap = new Map();
  for (const player of state.players) {
    if (!player.teamId) continue;
    const id = String(player.teamId);
    if (!teamMap.has(id)) {
      teamMap.set(id, {
        id,
        abbr: player.teamAbbr || state.teams.get(id)?.abbr || '',
      });
    }
  }
  const options = [...teamMap.values()].sort((a, b) =>
    (cnTeam(a.abbr) || a.abbr).localeCompare(cnTeam(b.abbr) || b.abbr, 'zh-CN')
  );
  const signature = options.map((option) => option.id + ':' + option.abbr).join('|');

  if (signature !== teamOptionsSignature) {
    teamOptionsSignature = signature;
    el.teamFilter.innerHTML =
      '<option value="all">全部球队</option>' +
      options
        .map((option) => `<option value="${esc(option.id)}">${esc(cnTeam(option.abbr) || option.abbr)}</option>`)
        .join('');
  }
  if (!options.some((option) => option.id === String(state.filterTeam))) {
    state.filterTeam = 'all';
  }
  el.teamFilter.value = state.filterTeam;
}

function renderUpdated() {
  const snap = !state.hasData ? activeSnapshot() : null;
  let text;
  if (!state.lastUpdated) {
    if (state.refreshing) {
      text = snap ? '正在更新 · 显示缓存数据' : '加载中…';
    } else if (state.loadError) {
      text = snap ? '刷新失败 · 显示缓存数据' : '更新失败';
    } else {
      text = snap ? '显示缓存数据' : '加载中…';
    }
  } else if (state.refreshing) {
    text = '刷新中…';
  } else {
    const time = state.lastUpdated.toLocaleTimeString('zh-CN', { hour12: false });
    text = slateIsSettled()
      ? `更新于 ${time} · ${state.games.length ? '比赛已全部结束' : '当日无比赛'}，停止自动刷新`
      : `更新于 ${time} · ${Math.max(0, secondsLeft)}s 后刷新`;
  }
  el.updatedAt.textContent = text;
  if (el.teamUpdatedAt) el.teamUpdatedAt.textContent = text;
  if (el.refreshHint) {
    el.refreshHint.textContent = slateIsSettled()
      ? '手动刷新或切换日期'
      : `每 ${REFRESH_SECONDS} 秒自动刷新`;
  }
}

function renderGrid() {
  if (!state.players.length) {
    el.grid.innerHTML = '';
    el.emptyState.hidden = false;
    el.emptyState.innerHTML = `${emptyIcon()}
      <h3>还没有关注球员</h3>
      <p>加上你关注的球员，比赛日的数据会自动出现在这里。</p>
      <button class="primary-btn" data-open-add>+ 添加球员</button>`;
    return;
  }

  // 本次还没拿到数据，但手上有同日期快照 → 先用快照，别闪成空白
  const snap = !state.hasData ? activeSnapshot() : null;
  if (snap) {
    el.grid.innerHTML = snap.grid;
    el.emptyState.hidden = true;
    return;
  }

  if (!state.hasData) {
    if (state.loadError) {
      el.grid.innerHTML = '';
      el.emptyState.hidden = false;
      el.emptyState.innerHTML = `${emptyIcon()}
        <h3>数据加载失败</h3>
        <p>${esc(state.loadError.message || '网络异常，请稍后重试')}</p>
        <button class="primary-btn" data-retry>重新加载</button>`;
    } else {
      el.grid.innerHTML = skeletonHTML(4);
      el.emptyState.hidden = true;
    }
    return;
  }

  const rows = visibleRows();
  if (!rows.length) {
    el.grid.innerHTML = '';
    el.emptyState.hidden = false;
    el.emptyState.innerHTML =
      state.filterStatus === 'hot'
        ? `${emptyIcon()}
          <h3>还没有球员达到打得好门槛</h3>
          <p>上场至少 ${HOT_MIN_MINUTES} 分钟，且满足任意 ${HOT_MIN_RULES} 项门槛后会出现在这里；出手 ≥${HOT_DQ_MIN_ATTEMPTS} 次但效率过低（真实命中率 <${HOT_DQ_MIN_TS}% 或得分 <${HOT_DQ_MIN_POINTS}）的场次一票否决。</p>
          <button class="text-btn" data-reset-filters>清除筛选</button>`
        : `${emptyIcon()}
          <h3>当前筛选下没有球员</h3>
          <p>换个状态或球队看看。</p>
          <button class="text-btn" data-reset-filters>清除筛选</button>`;
    return;
  }

  el.emptyState.hidden = true;
  const showRanks = state.sortKey !== 'name' && state.sortDir === 'desc';
  const leader = leaderForSort(state.rows);
  let rank = 0;
  el.grid.innerHTML = rows
    .map((row) =>
      cardHTML({
        row,
        rank: row.played && showRanks ? ++rank : 0,
        isTop: !!leader && row.player.id === leader.row.player.id,
        leaderBadge: leader?.badge || '',
      })
    )
    .join('');
}

function revealPlayer(id) {
  const playerId = String(id);
  state.view = 'players';
  saveView();
  state.filterStatus = 'all';
  state.filterTeam = 'all';
  render();
  const card = document.getElementById('card-' + playerId);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 1600);
}

function cardHTML({ row, rank, isTop, leaderBadge }) {
  const player = row.player;
  const team = row.team;
  const abbr = team?.abbr || player.teamAbbr || '';
  const color = team?.color || '#ff7a1a';
  const name = displayName(player);
  const meta = [cnTeam(abbr) || team?.short || abbr, CN_POSITIONS[player.pos] || player.pos]
    .filter(Boolean)
    .join(' · ');
  const teamLogoUrl = team?.logo || teamLogo(abbr);
  const courtLine =
    row.state === 'live' && row.played && row.onCourt !== null
      ? `<div class="court-line ${row.onCourt ? 'on' : 'off'}">
          <span class="court-dot"></span>${row.onCourt ? '在场中' : '休息中'}
          <span class="court-mins">· 上场 ${Math.round(row.stats.minutes)} 分钟</span>
        </div>`
      : '';
  const pillTone =
    row.state === 'live' && row.played
      ? row.meta?.halftime
        ? ' halftime'
        : row.meta?.endPeriod
          ? ' break'
          : ''
      : '';
  const hotLabel = row.hot ? row.hot.map((reason) => reason.label).join('、') : '';
  const badge = isTop
    ? `<span class="crown">${esc(leaderBadge || '得分王')}</span>`
    : row.hot
      ? `<span class="hot-badge" title="${esc('满足：' + hotLabel)}">打得好</span>`
      : '';
  const bagTag =
    playerGroup(player) === 'bag' ? `<span class="bag-tag" title="来自我的背包">背包</span>` : '';
  const hotStats = hotStatsFor(player.id);
  const verdict = hotVerdict(hotStats);
  const hotStatsLine = hotStats
    ? `<div class="hot-stats ${verdict}" title="${esc(HOT_SEASON_NOTE)}">
        <span class="hs-label">赛季火热</span>
        <span class="hs-count"><b>${hotStats.hotGames}</b>/${hotStats.games} 场</span>
        <span class="hs-verdict">${
          verdict === 'stable'
            ? `稳定 · 已达 ${state.hotThreshold} 场`
            : verdict === 'flash'
              ? '昙花一现'
              : '尚未达标'
        }</span>
      </div>`
    : row.played && state.hotStatsLoading
      ? `<div class="hot-stats pending" title="正在拉取该球员本赛季的逐场数据">
          <span class="hs-label">赛季火热</span>
          <span class="hs-count">统计中…</span>
        </div>`
      : row.played && state.hotStatsLoaded
        ? `<div class="hot-stats none" title="本赛季暂无可用场次，或逐场数据拉取失败">
            <span class="hs-label">赛季火热</span>
            <span class="hs-count">暂无数据</span>
          </div>`
        : '';
  const foot = row.played
    ? `<span>投篮 ${row.stats.fgm}-${row.stats.fga} · 三分 ${row.stats.tpm}-${row.stats.tpa} · 罚球 ${row.stats.ftm}-${row.stats.fta}</span>
       <span class="foot-sub"><span class="foot-item${state.sortKey === 'offRebounds' ? ' focus' : ''}">前板 ${row.stats.oreb}</span> · 后板 ${row.stats.dreb} · 失误 ${row.stats.tov} · <span class="foot-item${state.sortKey === 'plusMinus' ? ' focus' : ''}${row.hot?.some((r) => r.key === 'pm') ? ' hit' : ''}">正负 ${esc(fmtSigned(row.stats.plusMinus))}</span></span>`
    : row.state === 'bench'
      ? `未上场${row.reason ? ' · ' + esc(row.reason) : ' · 未获得出场时间'}`
      : row.state === 'pre'
        ? '比赛尚未开始'
        : row.state === 'idle'
          ? player.teamId
            ? `球队${state.dateParam ? '当日' : '今日'}没有比赛`
            : '暂无球队信息'
          : row.game
            ? playerPendingText(row.game.id)
            : '技术统计同步中';

  return `<article id="card-${esc(player.id)}" data-player-id="${esc(player.id)}" class="card ${row.played ? 'is-played' : 'is-bench'}${
    isTop ? ' is-top' : ''
  }${row.hot ? ' is-hot' : ''}" style="--team-color:${color}" title="${esc(
    player.name
  )}${hotLabel ? ' · 打得好：' + esc(hotLabel) : row.dq ? ' · 不计入打得好：' + esc(row.dq) : ''}">
    <div class="card-head">
      ${avatarHTML(player, { color, rank })}
      <div class="who">
        <div class="name"><span class="name-text" title="${esc(name)}">${esc(name)}</span>${badge}${bagTag}</div>
        <div class="meta">
          ${teamLogoUrl ? `<img src="${esc(teamLogoUrl)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
          <span>${esc(meta)}</span>
        </div>
        ${courtLine}
      </div>
      <div class="card-tools">
        <span class="pill ${row.state}${pillTone}">${esc(row.statusLabel)}</span>
        <button class="remove" data-remove="${esc(player.id)}" title="取消关注" aria-label="取消关注 ${esc(player.name)}">×</button>
      </div>
    </div>
    ${gameLineHTML(row)}
    <div class="stats">${row.played ? statCells(row.stats, row.hot) : emptyStatCells()}</div>
    ${row.played ? advCells(row.stats, row.hot) : ''}
    ${hotStatsLine}
    <div class="card-foot">${foot}</div>
  </article>`;
}

function gameLineHTML(row) {
  if (!row.game) {
    const abbr = row.team?.abbr || row.player.teamAbbr || '';
    const dayWord = state.dateParam ? '当日' : '今日';
    const label = abbr ? `${cnTeam(abbr) || abbr} ${dayWord}无比赛` : '暂无球队信息';
    return `<div class="game-line no-game"><span class="matchup">${esc(label)}</span></div>`;
  }

  const { me, opp, game } = row;
  const meta = row.meta || {};
  const meLogo = me.logo || teamLogo(me.abbr);
  const oppLogo = opp.logo || teamLogo(opp.abbr);
  const score =
    game.state === 'pre'
      ? '<span class="vs">vs</span>'
      : `<b>${esc(me.score)}</b><span class="colon">:</span><b>${esc(opp.score)}</b>`;
  const timeoutTag = (active) =>
    active && Date.now() < meta.timeoutUntil
      ? `<span class="timeout-tag" data-timeout-until="${meta.timeoutUntil}">${esc(timeoutStatusText(meta.timeoutUntil))}</span>`
      : '';
  const meTimeout = meta.timeoutTeamId && meta.timeoutTeamId === me.teamId;
  const oppTimeout = meta.timeoutTeamId && meta.timeoutTeamId === opp.teamId;

  let statusHTML;
  if (game.state === 'live' && meta.halftime) {
    statusHTML = `<span class="game-status halftime" data-halftime-ends="${meta.halftimeEndsAt}" data-halftime-mode="full">${esc(halftimeStatusText(meta.halftimeEndsAt))}</span>`;
  } else if (game.state === 'live' && meta.endPeriod) {
    statusHTML = `<span class="game-status break" data-break-ends="${meta.breakEndsAt || 0}" data-break-period="${game.period}">${esc(
      breakStatusText(meta.breakEndsAt, game.period)
    )}</span>`;
  } else {
    statusHTML = `<span class="game-status ${game.state}">${esc(row.statusText)}</span>`;
  }

  return `<div class="game-line">
    <span class="matchup">
      <img src="${esc(meLogo)}" alt="" loading="lazy" onerror="this.remove()">
      <span class="abbr">${esc(me.abbr)}</span>
      ${timeoutTag(meTimeout)}
      ${score}
      <span class="abbr">${esc(opp.abbr)}</span>
      ${timeoutTag(oppTimeout)}
      <img src="${esc(oppLogo)}" alt="" loading="lazy" onerror="this.remove()">
    </span>
    ${statusHTML}
  </div>`;
}

/** 把命中的维度映射到具体的数据格子，用于标亮 */
function hitCells(stats, reasons) {
  const hit = new Set();
  for (const reason of reasons || []) {
    if (reason.key === 'pts') hit.add('points');
    else if (reason.key === 'reb') hit.add('rebounds');
    else if (reason.key === 'ast') hit.add('assists');
    else if (reason.key === 'stocks') {
      // 断帽是合计达标，两格都亮
      hit.add('steals');
      hit.add('blocks');
    } else if (reason.key === 'dd' || reason.key === 'td') {
      // 两双/三双：亮出上双的那几格
      if (stats.pts >= 10) hit.add('points');
      if (stats.reb >= 10) hit.add('rebounds');
      if (stats.ast >= 10) hit.add('assists');
      if (stats.stl >= 10) hit.add('steals');
      if (stats.blk >= 10) hit.add('blocks');
    }
  }
  return hit;
}

function statCells(stats, reasons) {
  return statGrid(
    [
      ['points', '得分', stats.pts],
      ['rebounds', '篮板', stats.reb],
      ['assists', '助攻', stats.ast],
      ['steals', '抢断', stats.stl],
      ['blocks', '盖帽', stats.blk],
      ['minutes', '分钟', Math.round(stats.minutes)],
    ],
    hitCells(stats, reasons)
  );
}

function emptyStatCells() {
  return statGrid([
    ['points', '得分', '—'],
    ['rebounds', '篮板', '—'],
    ['assists', '助攻', '—'],
    ['steals', '抢断', '—'],
    ['blocks', '盖帽', '—'],
    ['minutes', '分钟', '—'],
  ]);
}

function statGrid(cells, hit) {
  return cells
    .map(([key, label, value]) => {
      const classes = ['stat'];
      if (state.sortKey === key) classes.push('main');
      if (hit && hit.has(key)) classes.push('hit');
      return `<div class="${classes.join(' ')}"><b>${value}</b><span>${label}</span></div>`;
    })
    .join('');
}

function advCells(stats, reasons) {
  const hitKeys = new Set((reasons || []).map((reason) => reason.key));
  const cells = [
    {
      key: 'ts',
      label: '真实命中率 TS%',
      value: fmtPct(stats.ts),
      title: '真实命中率 = 得分 / (2 × (出手 + 0.44 × 罚球出手))，按本场数据估算',
      hit: hitKeys.has('ts'),
    },
    {
      key: 'efg',
      label: '有效命中率 eFG%',
      value: fmtPct(stats.efg),
      title: '有效命中率 = (命中 + 0.5 × 三分命中) / 出手',
      tone: '',
    },
    {
      key: 'usg',
      label: '使用率 USG%',
      value: fmtPct(stats.usg),
      title: '估算使用率：球员在场时，以他出手、罚球或失误结束的进攻回合占比',
      tone: '',
    },
    {
      key: 'astPct',
      label: '助攻率 AST%',
      value: fmtPct(stats.astPct),
      title: '估算助攻率：球员在场时，队友命中投篮中由他助攻的比例',
      tone: '',
    },
    {
      key: 'rebPct',
      label: '篮板率 REB%',
      value: fmtPct(stats.rebPct),
      title: '估算篮板率：球员在场时抢到的可用篮板比例',
      tone: '',
    },
    {
      key: 'efficiency',
      label: '效率值 EFF',
      value: String(stats.eff),
      title: '单场效率值：得分 + 篮板 + 助攻 + 抢断 + 盖帽 − 投失 − 罚失 − 失误',
      tone: stats.eff < 0 ? 'bad' : '',
    },
  ];

  return `<div class="adv">${cells
    .map(
      (cell) =>
        `<div class="adv-cell${cell.tone ? ' ' + cell.tone : ''}${
          cell.hit ? ' hit' : ''
        }${state.sortKey === cell.key ? ' focus' : ''}" title="${esc(cell.title)}"><span>${cell.label}</span><b>${cell.value}</b></div>`
    )
    .join('')}</div>`;
}

function avatarHTML(player, { color = '', rank = 0, small = false } = {}) {
  return `<div class="avatar${small ? ' sm' : ''}"${color ? ` style="--team-color:${color}"` : ''}>
    <span class="avatar-fallback">${esc(initials(player))}</span>
    <img src="${esc(playerHeadshot(player))}" alt="" loading="lazy" onerror="this.remove()">
    ${rank ? `<span class="rank">${rank}</span>` : ''}
  </div>`;
}

function skeletonHTML(count) {
  return Array.from(
    { length: count },
    () => `<div class="card skeleton" aria-hidden="true">
      <div class="sk-head">
        <div class="sk sk-avatar"></div>
        <div class="sk-lines">
          <div class="sk sk-line w60"></div>
          <div class="sk sk-line w40"></div>
        </div>
      </div>
      <div class="sk sk-block"></div>
      <div class="sk-stats">${'<div class="sk sk-stat"></div>'.repeat(6)}</div>
      <div class="sk sk-line w60"></div>
    </div>`
  ).join('');
}

function emptyIcon() {
  return `<div class="empty-icon">
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
      <circle cx="16" cy="16" r="13"/>
      <path d="M3 16h26M16 3c4 4 4 22 0 26M16 3c-4 4-4 22 0 26M5.4 9.2c6.8 1.9 14.4 1.9 21.2 0M5.4 22.8c6.8-1.9 14.4-1.9 21.2 0"/>
    </svg>
  </div>`;
}

/* ---------- filtering & sorting ---------- */

function visibleRows() {
  const rows = state.rows.filter((row) => {
    if (state.filterStatus === 'played' && !row.played) return false;
    if (state.filterStatus === 'onCourt' && !(row.state === 'live' && row.onCourt === true)) return false;
    if (state.filterStatus === 'resting' && !(row.state === 'live' && row.onCourt === false)) return false;
    if (state.filterStatus === 'hot' && !row.hot?.length) return false;
    if (state.filterStatus === 'bag' && playerGroup(row.player) !== 'bag') return false;
    if (state.filterStatus === 'stable' && hotVerdict(hotStatsFor(row.player.id)) !== 'stable') return false;
    if (state.filterStatus === 'flash' && hotVerdict(hotStatsFor(row.player.id)) !== 'flash') return false;
    if (state.filterStatus === 'bench' && row.state !== 'bench') return false;
    if (state.filterStatus === 'idle' && row.state !== 'idle') return false;
    if (state.filterTeam !== 'all' && String(row.player.teamId) !== String(state.filterTeam)) return false;
    return true;
  });

  const direction = state.sortDir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    if (state.sortKey === 'name') {
      return a.player.name.localeCompare(b.player.name, 'en') * direction;
    }
    if (a.played !== b.played) return a.played ? -1 : 1;
    if (!a.played) return a.player.name.localeCompare(b.player.name, 'en');
    const aValue = sortValue(a, state.sortKey);
    const bValue = sortValue(b, state.sortKey);
    if (aValue == null && bValue == null) {
      return b.stats.pts - a.stats.pts || a.player.name.localeCompare(b.player.name, 'en');
    }
    if (aValue == null) return 1;
    if (bValue == null) return -1;
    const diff = aValue - bValue;
    if (diff !== 0) return diff * direction;
    return b.stats.pts - a.stats.pts || a.player.name.localeCompare(b.player.name, 'en');
  });
  return rows;
}

function sortValue(row, key) {
  const stats = row.stats;
  switch (key) {
    case 'points': return stats.pts;
    case 'rebounds': return stats.reb;
    case 'assists': return stats.ast;
    case 'steals': return stats.stl;
    case 'blocks': return stats.blk;
    case 'offRebounds': return stats.oreb;
    case 'minutes': return stats.minutes;
    case 'efficiency': return stats.eff;
    case 'ts': return stats.ts;
    case 'efg': return stats.efg;
    case 'usg': return stats.usg;
    case 'astPct': return stats.astPct;
    case 'rebPct': return stats.rebPct;
    case 'plusMinus': return stats.plusMinus;
    case 'hotGames': {
      const stats = state.hotStats[row.player.id];
      return stats && stats.games ? stats.hotGames : null;
    }
    default: return 0;
  }
}

function applySort(key) {
  if (!key) return;
  if (key !== state.sortKey) {
    state.sortKey = key;
    state.sortDir = key === 'name' ? 'asc' : 'desc';
    el.sortSelect.value = key;
    updateSortDir();
    renderSummary();
    renderGrid();
  }
  el.summaryBar.querySelectorAll('[data-leader-sort]').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.leaderSort === state.sortKey);
  });
}

function buildSortSelect() {
  el.sortSelect.innerHTML = SORTS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  el.sortSelect.value = state.sortKey;
  if (el.hotThreshold) el.hotThreshold.value = String(state.hotThreshold);
  updateSortDir();
}

function updateSortDir() {
  el.sortDirBtn.textContent = state.sortDir === 'desc' ? '↓' : '↑';
  const title = state.sortDir === 'desc' ? '当前降序，点击切换升序' : '当前升序，点击切换降序';
  el.sortDirBtn.title = title;
  el.sortDirBtn.setAttribute('aria-label', title);
}

/* ---------- dates & refresh ---------- */

function shiftDate(delta) {
  if (!state.slateDate) return;
  state.dateParam = offsetDate(state.slateDate, delta);
  state.slateDate = paramToDate(state.dateParam);
  state.summaries = new Map();
  summaryFailCounts.clear();
  state.hasData = false;
  state.loadError = null;
  render();
  refresh();
}

function paramToDate(param) {
  return `${param.slice(0, 4)}-${param.slice(4, 6)}-${param.slice(6, 8)}`;
}

function currentEtDate() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = {};
  for (const part of parts) values[part.type] = part.value;
  return `${values.year}-${values.month}-${values.day}`;
}

function offsetDate(dateString, delta) {
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + delta));
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function manualRefresh() {
  secondsLeft = REFRESH_SECONDS;
  state.loadError = null;
  // 用户主动刷新 → 穿透服务端缓存，避免「点了没反应」
  bypassCacheOnce = true;
  if (!state.hasData) render();
  refresh();
}

function startTicker() {
  el.refreshHint.textContent = `每 ${REFRESH_SECONDS} 秒自动刷新`;
  setInterval(() => {
    if (document.hidden) return;
    updateLiveClocks();
    if (state.refreshing) {
      renderUpdated();
      return;
    }
    secondsLeft -= 1;
    if (secondsLeft <= 0) {
      if (slateIsSettled() && !statsIncomplete()) {
        secondsLeft = 0; // 无比赛 / 已全部结束且数据齐全：停掉自动刷新，等手动刷新或切日期
      } else {
        secondsLeft = REFRESH_SECONDS;
        refresh();
      }
    }
    renderUpdated();
  }, 1000);
}

/* ---------- add / remove ---------- */

function openModal() {
  el.modal.hidden = false;
  document.body.classList.add('modal-open');
  el.playerSearch.value = '';
  el.searchResults.innerHTML = '<div class="search-state">输入球员中文名或英文名开始搜索。</div>';
  searchCache = [];
  requestAnimationFrame(() => el.playerSearch.focus());
}

function closeModal() {
  el.modal.hidden = true;
  document.body.classList.remove('modal-open');
  clearTimeout(searchDebounce);
  searchSeq += 1;
}

function onSearchInput() {
  if (searchComposing) return; // 中文输入法组词过程中不触发，等 compositionend
  const query = el.playerSearch.value.trim();
  clearTimeout(searchDebounce);
  searchSeq += 1;

  if (query.length < 2) {
    searchCache = [];
    el.searchResults.innerHTML = '<div class="search-state">至少输入 2 个字符。</div>';
    return;
  }

  el.searchResults.innerHTML = '<div class="search-state">搜索中…</div>';
  searchDebounce = setTimeout(() => runSearch(query), 320);
}

const ESPN_PLAYER_FILTER = (item) =>
  item.type === 'player' && item.league === 'nba' && item.isActive !== false;

function normalizeEspnName(name) {
  return String(name || '').toLowerCase().replace(/[.\s]+/g, ' ').trim();
}

// 用英文名调 ESPN 搜索，优先返回与该英文名完全一致的那条
async function fetchPlayerByEnglishName(englishName) {
  try {
    const data = await fetchJSON(API.search(englishName));
    const items = (data.items || []).filter(ESPN_PLAYER_FILTER);
    const target = normalizeEspnName(englishName);
    return items.find((item) => normalizeEspnName(item.displayName) === target) || items[0] || null;
  } catch (error) {
    return null;
  }
}

async function runSearch(query) {
  const seq = ++searchSeq;
  try {
    const items = [];
    const seen = new Set();
    const push = (item) => {
      if (!item) return;
      const key = String(item.id);
      if (seen.has(key)) return;
      seen.add(key);
      items.push(item);
    };

    if (CJK_RE.test(query)) {
      // 1) 本地名单命中（已关注 / 背包 / 收藏导入），直接出结果
      for (const player of localCnMatches(query)) push(localPlayerToItem(player));

      // 2) 全联盟译名反查英文名，并行调 ESPN 补本地没有的球员
      const covered = new Set(Object.keys(CN_PLAYER_INDEX));
      for (const player of state.players) {
        const norm = normalizeSearchText(player.cn);
        if (norm) covered.add(norm);
      }
      const pending = cnNameToEnglishMatches(query).filter((hit) => !covered.has(hit.norm));
      if (pending.length) {
        const found = await Promise.all(pending.map((hit) => fetchPlayerByEnglishName(hit.en)));
        if (seq !== searchSeq) return;
        for (const item of found) push(item);
      }

      // 3) 中文什么都没命中时，退回用原词直查一次接口兜底
      if (!items.length) {
        const data = await fetchJSON(API.search(query));
        if (seq !== searchSeq) return;
        for (const item of (data.items || []).filter(ESPN_PLAYER_FILTER)) push(item);
      }
    } else {
      const data = await fetchJSON(API.search(query));
      if (seq !== searchSeq) return;
      for (const item of (data.items || []).filter(ESPN_PLAYER_FILTER)) push(item);
    }

    searchCache = items;
    renderSearchResults(items, query);
  } catch (error) {
    if (seq !== searchSeq) return;
    el.searchResults.innerHTML = `<div class="search-state">搜索失败：${esc(error.message)}</div>`;
  }
}

function renderSearchResults(items, query) {
  if (!items.length) {
    el.searchResults.innerHTML = `<div class="search-state">没有找到“${esc(query)}”，试试中文译名或英文姓氏，如 Jaquez。</div>`;
    return;
  }

  el.searchResults.innerHTML = items
    .map((item) => {
      const core = (item.teamRelationships || []).find((relation) => relation.type === 'team')?.core;
      const teamInfo = core ? state.teams.get(String(core.id)) : null;
      const followed = state.players.some((player) => String(player.id) === String(item.id));
      const zhName = item._cn || playerNameZh(item.displayName);
      const subtitle = [
        core ? cnTeam(core.abbreviation) || core.displayName : '自由球员',
        item.position?.abbreviation || '',
      ]
        .filter(Boolean)
        .join(' · ');
      return `<div class="search-row">
        ${avatarHTML(
          { id: item.id, name: item.displayName, headshot: item.headshot?.href || '', cn: zhName },
          { color: teamInfo?.color || '', small: true }
        )}
        <div class="search-who">
          <b>${esc(zhName || item.displayName)}</b>
          <span>${esc([zhName ? item.displayName : '', subtitle].filter(Boolean).join(' · '))}</span>
        </div>
        <button class="btn-add" data-add="${esc(item.id)}" ${followed ? 'disabled' : ''}>${
          followed ? '已关注' : '+ 关注'
        }</button>
      </div>`;
    })
    .join('');
}

function onSearchResultClick(event) {
  const button = event.target.closest('[data-add]');
  if (!button || button.disabled) return;
  const item = searchCache.find((candidate) => String(candidate.id) === button.dataset.add);
  if (item) addPlayer(item);
}

function addPlayer(item) {
  if (state.players.some((player) => String(player.id) === String(item.id))) return;
  const core = (item.teamRelationships || []).find((relation) => relation.type === 'team')?.core;
  const zhName = item._cn || playerNameZh(item.displayName);
  state.players.push({
    id: String(item.id),
    name: item.displayName,
    cn: zhName,
    pos: item.position?.abbreviation || '',
    teamId: core ? String(core.id) : '',
    teamAbbr: core?.abbreviation || '',
    headshot: item.headshot?.href || '',
  });
  savePlayers();
  closeModal();
  teamOptionsSignature = '';
  state.rows = buildRows();
  render();
  showToast(`已关注 ${zhName || item.displayName}`);
  refresh();
}

function removePlayer(id) {
  const index = state.players.findIndex((player) => String(player.id) === String(id));
  if (index < 0) return;
  const [removed] = state.players.splice(index, 1);
  savePlayers();
  teamOptionsSignature = '';
  state.rows = buildRows();
  render();
  showToast(`已移除 ${displayName(removed)}`, '撤销', () => {
    state.players.splice(index, 0, removed);
    savePlayers();
    teamOptionsSignature = '';
    state.rows = buildRows();
    render();
  });
}

/* ---------- 备份导出 / 导入 ---------- */

// 需要备份的用户数据 key；一次性导入标记（IMPORT_ONCE_KEY / BAG_IMPORT_KEY）不收，
// 导入逻辑按 id 幂等，不备份也不会造成重复添加
const BACKUP_KEYS = [STORE_KEY, HOT_THRESHOLD_KEY, VIEW_KEY, HOT_ALERT_KEY, HOT_STATS_KEY];

function backupFileName() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `nba-stand-backup-${stamp}.json`;
}

function exportBackup() {
  const items = {};
  for (const key of BACKUP_KEYS) {
    const raw = localStorage.getItem(key);
    if (raw == null) continue;
    try {
      items[key] = JSON.parse(raw); // 解析后存入，备份文件更可读
    } catch (error) {
      items[key] = raw; // 解析不了就原样存，保证不丢
    }
  }

  const backup = {
    app: 'nba-stand',
    version: STORE_VERSION,
    exportedAt: new Date().toISOString(),
    players: items[STORE_KEY]?.players?.length ?? 0,
    items,
  };

  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = backupFileName();
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  const saved = BACKUP_KEYS.filter((key) => key in items).length;
  showToast(`已导出备份：${saved} 项数据 · ${backup.players} 名关注球员`);
}

function onImportFileChange(event) {
  const input = event.target;
  const file = input.files?.[0];
  input.value = ''; // 清空，允许再次选同一个文件
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      applyBackup(String(reader.result || ''));
    } catch (error) {
      showToast('导入失败：' + (error.message || '文件解析出错'));
    }
  };
  reader.onerror = () => showToast('导入失败：无法读取文件');
  reader.readAsText(file, 'utf-8');
}

function applyBackup(text) {
  const backup = JSON.parse(text);
  if (!backup || backup.app !== 'nba-stand' || typeof backup.items !== 'object' || backup.items === null) {
    throw new Error('不是 NBA 看台的备份文件');
  }

  const keys = Object.keys(backup.items).filter((key) => BACKUP_KEYS.includes(key));
  if (!keys.length) throw new Error('备份文件里没有可恢复的数据');

  const backupPlayers = backup.items[STORE_KEY]?.players?.length ?? 0;
  const ok = confirm(
    '导入将覆盖当前的关注名单等数据。\n\n' +
      `当前：${state.players.length} 名关注球员\n` +
      `备份：${backupPlayers} 名关注球员\n\n` +
      '确定要继续吗？'
  );
  if (!ok) return;

  for (const key of keys) {
    const value = backup.items[key];
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  // 备份不含一次性导入标记时补上，避免导入后又跑一遍种子导入、把删掉的球员加回来
  for (const key of [IMPORT_ONCE_KEY, BAG_IMPORT_KEY]) {
    if (!(key in backup.items) && !localStorage.getItem(key)) {
      localStorage.setItem(key, JSON.stringify({ restored: true, at: Date.now() }));
    }
  }

  showToast(`已恢复 ${keys.length} 项数据，正在刷新…`);
  setTimeout(() => location.reload(), 600);
}

/* ---------- toast & error ---------- */

function showToast(message, actionLabel, action, tone = '') {
  clearTimeout(toastTimer);
  el.toast.dataset.tone = tone;
  el.toast.innerHTML = `<span>${esc(message)}</span>${
    actionLabel ? `<button type="button" id="toastAction">${esc(actionLabel)}</button>` : ''
  }`;
  el.toast.hidden = false;
  requestAnimationFrame(() => el.toast.classList.add('show'));

  if (actionLabel) {
    const actionButton = document.getElementById('toastAction');
    if (actionButton) {
      actionButton.addEventListener('click', () => {
        action?.();
        hideToast();
      });
    }
  }
  toastTimer = setTimeout(hideToast, actionLabel ? 5000 : 2600);
}

function hideToast() {
  el.toast.classList.remove('show');
  setTimeout(() => {
    el.toast.hidden = true;
  }, 200);
}

function showError(error) {
  el.errorBanner.hidden = false;
  el.errorText.textContent = '数据更新失败：' + (error?.message || '网络异常');
}

function hideError() {
  el.errorBanner.hidden = true;
}

/* ---------- helpers ---------- */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function num(value) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseMinutes(value) {
  const [minutes, seconds] = String(value ?? '').split(':');
  const parsedMinutes = parseFloat(minutes);
  const parsedSeconds = parseFloat(seconds);
  if (!Number.isFinite(parsedMinutes)) return 0;
  return parsedMinutes + (Number.isFinite(parsedSeconds) ? parsedSeconds / 60 : 0);
}

function parseSplit(value) {
  const parts = String(value ?? '').trim().split('-');
  return {
    made: num(parts[0]),
    att: num(parts[1] ?? parts[0]),
  };
}

function parsePlusMinus(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || text === '-') return null;
  const parsed = parseFloat(text.replace(/^\+/, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function fmtPct(value) {
  return value == null ? '—' : value.toFixed(1);
}

function fmtSigned(value) {
  if (value == null) return '—';
  return value > 0 ? `+${value}` : String(value);
}

function reasonText(reason) {
  if (!reason) return '';
  const key = String(reason).toUpperCase().trim();
  return REASON_CN[key] || reason;
}

function cnTeam(abbr) {
  return CN_TEAMS[String(abbr || '').toUpperCase()] || '';
}

function registerTeam(team) {
  if (!team?.id) return;
  state.teams.set(String(team.id), {
    id: String(team.id),
    abbr: team.abbreviation || '',
    name: team.displayName || '',
    short: team.shortDisplayName || team.name || '',
    logo: team.logo || teamLogo(team.abbreviation),
    color: team.color ? '#' + team.color : '#3b82f6',
  });
}

function teamLogo(abbr) {
  return abbr ? `https://a.espncdn.com/i/teamlogos/nba/500/${String(abbr).toLowerCase()}.png` : '';
}

function playerHeadshot(player) {
  if (player.headshot) return player.headshot;
  return player.id ? `https://a.espncdn.com/i/headshots/nba/players/full/${player.id}.png` : '';
}

function normalizePlayerName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function playerNameKeys(name) {
  const key = normalizePlayerName(name);
  if (!key) return [];
  const keys = [key];
  const stripped = key.replace(/\s+(jr|sr|ii|iii|iv)$/, '');
  if (stripped !== key) keys.push(stripped);
  return keys;
}

function playerNameZh(name) {
  const keys = playerNameKeys(name);
  for (const key of keys) {
    if (NAME_ZH[key]) return NAME_ZH[key];
  }
  for (const key of keys) {
    const tokens = key.split(' ');
    if (tokens.length !== 2) continue;
    const last = NAME_ZH_PARTS.last[tokens[1]];
    if (last) return last;
  }
  return '';
}

function displayName(player) {
  return player.cn || playerNameZh(player.name) || player.name;
}

function initials(player) {
  if (player.cn) return player.cn.slice(0, 1);
  const parts = String(player.name || '').trim().split(/\s+/);
  if (!parts[0]) return '?';
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function periodLabel(period) {
  if (!period) return '';
  return period <= 4 ? `第${period}节` : `加时${period - 4}`;
}

function formatTip(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return sameDay ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}
