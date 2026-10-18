// 공항 도착 후 입국 절차 안내 (앱 안에 들어 있어서 인터넷·GPS 없이도 보임)
// 나라별 안내가 없으면 공통 안내. 규정은 바뀔 수 있으니 공항 안내 표지를 우선하라고 함께 알림

const COMMON = [
  { icon: '📝', title: '입국신고서', text: '비행기에서 나눠 주는 입국신고서·세관신고서를 미리 써 두세요. 숙소 주소(첫 숙소)를 적는 칸이 있어요.' },
  { icon: '🛂', title: '입국심사', text: '"Arrivals / Immigration" 표지를 따라가요. 여권과 신고서를 준비하세요. 왕복 항공권·숙소 예약을 물어볼 수 있어요.' },
  { icon: '🧳', title: '짐 찾기', text: '"Baggage Claim" 전광판에서 내 편명(예: KE401)을 찾아 벨트 번호로 가요.' },
  { icon: '🛃', title: '세관', text: '신고할 물건이 없으면 초록색(Nothing to Declare), 있으면 빨간색(Goods to Declare) 줄로 가요.' },
  { icon: '🚪', title: '도착장', text: '나오면 유심·환전·교통편 안내가 있어요. 앱에서 [나왔어요]를 누르면 다음 장소까지 시간을 다시 계산해요.' },
];

const BY_TZ = {
  // 호주 (시드니·멜버른·브리즈번·퍼스 등)
  Australia: [
    { icon: '📝', title: '입국신고서 (Incoming Passenger Card)', text: '비행기에서 받은 카드를 써요. 음식·약·식물·흙 묻은 신발, 현금 1만 호주달러 이상이 있으면 "Yes"에 표시하세요. 헷갈리면 Yes로 신고하는 게 안전해요.' },
    { icon: '🛂', title: '입국심사', text: '전자여권이면 SmartGate(셀프 심사기)를 쓸 수 있어요: 여권을 넣고 화면 안내 → 카메라 촬영. 안 되면 직원 심사대로 가요. 비자(ETA)는 출발 전에 받아 둔 상태여야 해요.' },
    { icon: '🧳', title: '짐 찾기', text: '"Baggage Reclaim" 전광판에서 편명으로 벨트 번호를 확인해요.' },
    { icon: '🛃', title: '검역·세관 (가장 엄격)', text: '입국신고서를 직원에게 내요. 김치·육포·라면 수프(고기 성분)·과일·견과류는 꼭 신고하세요. 신고하면 대부분 문제없지만, 숨기면 큰 벌금이에요. 짐이 X-ray를 한 번 더 통과할 수 있어요.' },
    { icon: '🚪', title: '도착장 → 시내', text: '시드니는 기차(공항역, 약 15분·공항 이용료 포함 약 20호주달러), 택시(약 30~40분·약 60~80호주달러), 우버(픽업 구역 표지)가 있어요. 기차·버스는 교통카드 없이 신용·체크카드(컨택리스)를 개찰구에 찍으면 돼요. 내릴 때도 꼭 찍으세요.' },
  ],
  Pacific_Auckland: null,
};

/** 그 시간대(도착 공항)에 맞는 입국 절차 */
export function arrivalGuide(tz) {
  const region = tz?.startsWith('Australia/') ? 'Australia' : null;
  return { steps: (region && BY_TZ[region]) || COMMON, specific: !!region };
}
