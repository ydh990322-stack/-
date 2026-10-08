// 커뮤니티 운영 정책 (포인트 지급 기준 등은 여기서 조정)
const path = require('node:path');

module.exports = {
  port: Number(process.env.PORT) || 3000,
  siteName: process.env.SITE_NAME || '맘앤대디 라운지',
  dbFile: process.env.DB_FILE || path.join(__dirname, 'data', 'community.db'),
  sessionDays: 30,

  // 최초 실행 시 생성되는 관리자 계정 (운영 전 반드시 환경변수로 변경)
  admin: {
    email: process.env.ADMIN_EMAIL || 'admin@momdad.kr',
    password: process.env.ADMIN_PASSWORD || 'admin1234!',
  },

  points: {
    signup: 1000, //                     가입 축하
    referrer: 2000, //                   친구를 초대한 회원
    referee: 1000, //                    초대 코드로 가입한 회원 추가 보너스
    attendance: 100, //                  매일 출석
    attendanceStreak7: 500, //           7일 연속 출석 보너스
    post: { type: 'post', points: 50, dailyLimit: 5 },
    comment: { type: 'comment', points: 10, dailyLimit: 20 },
    likeReceived: { type: 'like_received', points: 5, dailyLimit: 20 },
    eventEntry: 100, //                  정기 이벤트 참여
    weeklyPrize: 3000, //                정기 이벤트 당첨
    weeklyWinners: 3,
  },

  withdrawal: {
    pointToWon: 1, //   1P = 1원
    minimum: 10000, //  최소 출금 포인트
    fee: 500, //        출금 수수료 (포인트)
    dailyLimit: 1, //   하루 출금 신청 횟수
    minAccountAgeDays: 7, // 가입 후 N일 지나야 출금 가능 (어뷰징 방지)
  },
};
