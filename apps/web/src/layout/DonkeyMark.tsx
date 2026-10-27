// The Material Mule mark: a walking donkey from the design system (Logos, adopted 2026-10-26),
// paths unchanged. One-colour silhouette in currentColor; the mask cuts the gaps between the near
// and far legs so it sits on any ground. Decorative: the header always shows the name beside it.

const LEG_GAPS = [
  'M505,680 C505,760 465,800 470,850 C474,890 505,915 520,935 C530,948 538,960 542,970 L482,970 C480,955 470,945 466,935 C450,900 410,870 398,830 C392,800 395,770 380,730 Z',
  'M745,680 L862,630 C852,665 845,695 850,710 C870,760 895,800 905,840 C912,880 925,905 945,925 C965,945 985,958 992,970 L930,970 C928,955 922,945 920,930 C905,890 880,850 860,820 C830,780 790,740 745,700 Z',
];

const FAR_LEGS = [
  'M350,690 C360,730 380,745 395,765 C380,790 350,805 320,825 C290,850 272,880 268,920 C272,935 285,950 292,970 L232,970 L232,955 C238,945 230,930 240,915 C260,880 280,840 300,800 C320,780 340,760 350,690 Z',
  'M715,700 L770,720 C760,770 740,800 725,840 C710,880 700,910 715,970 L655,970 C660,950 648,935 650,915 C665,870 690,820 705,780 C712,760 712,730 715,700 Z',
];

const BODY = [
  'M352,595 C335,615 320,640 300,665 C285,680 275,700 262,720 C240,752 200,768 165,772 C180,755 185,735 200,710 C220,680 250,660 280,655 C300,640 315,600 340,575 Z',
  'M340,580 C365,535 425,503 500,500 C580,497 640,520 700,505 C760,490 805,465 845,435 C885,405 912,390 938,390 L1000,405 C1025,430 1042,452 1047,472 C1060,510 1080,545 1087,577 C1092,605 1074,628 1050,628 C1030,628 1018,614 1014,600 C980,582 945,568 925,540 C902,578 878,612 862,632 L850,700 L745,690 C700,715 640,728 590,722 C550,716 522,702 505,690 L495,700 C470,745 420,745 395,735 C355,690 330,640 340,580 Z',
  'M765,490 C785,478 805,474 822,468 L812,490 Z',
  ...LEG_GAPS,
  'M935,412 C928,360 945,300 995,255 C1002,300 992,360 975,405 Z',
  'M978,402 C1000,340 1040,300 1075,270 C1082,320 1052,380 1008,412 Z',
];

export function DonkeyMark() {
  return (
    <svg width={26} height={21} viewBox="150 230 960 760" aria-hidden="true" focusable="false">
      <defs>
        <mask
          id="mm-donkey-leg-gaps"
          maskUnits="userSpaceOnUse"
          x="150"
          y="230"
          width="960"
          height="760"
        >
          <rect x="150" y="230" width="960" height="760" fill="#fff" />
          <g fill="#000" stroke="#000" strokeWidth={16} strokeLinejoin="round">
            {LEG_GAPS.map((d) => (
              <path key={d} d={d} />
            ))}
          </g>
        </mask>
      </defs>
      <g fill="currentColor">
        <g mask="url(#mm-donkey-leg-gaps)">
          {FAR_LEGS.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>
        {BODY.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}
