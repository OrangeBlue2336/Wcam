const monitorZones = [
    {
        name: "독도 태극기",
        tileUrl: "https://backend.wplace.live/files/s0/tiles/1774/795.png",
        tileX: 1774, tileY: 795, // /s0/pixel 훼손자 조회용 (tileUrl과 동일한 좌표, 파싱 없이 재사용)
        originalPath: "./assets/ref_dokdo.png",
        x: 40, y: 100, width: 361, height: 261,
        wplaceUrl: "https://wplace.live/?lat=37.26901731348799&lng=131.8750484967773&zoom=12.532754498466533"
    },
    {
        name: "서울 태극기",
        tileUrl: "https://backend.wplace.live/files/s0/tiles/1746/793.png",
        tileX: 1746, tileY: 793, // /s0/pixel 훼손자 조회용 (tileUrl과 동일한 좌표, 파싱 없이 재사용)
        originalPath: "./assets/ref_seoul.png",
        x: 420, y: 691, width: 160, height: 120,
        wplaceUrl: "https://wplace.live/?lat=37.47464909223321&lng=127.00204068427732&zoom=13.744052003011783"
    }
];

module.exports = monitorZones;
