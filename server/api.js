const axios = require('axios');
const sharp = require('sharp');
const { API_SECRET_KEY } = require('../config/env');

// API 키 검증 미들웨어
function validateApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    
    // API 키가 없거나 일치하지 않으면 차단
    if (!apiKey || apiKey !== API_SECRET_KEY) {
        console.log(`🚫 무단 API 접근 시도: IP=${req.ip}, Key=${apiKey ? '잘못된 키' : '키 없음'}`);
        return res.status(401).json({ 
            success: false, 
            error: 'Unauthorized access' 
        });
    }
    
    next();
}

module.exports = (app, { zoneMatchData, zoneHistory, monitorZones, client }) => {
    app.get('/', (req, res) => res.send('Wcam Bot is Running!'));

    // ✅ 새로운 API 엔드포인트 추가
    // 봇 상태 확인 API
    app.get('/api/status', validateApiKey, (req, res) => {
        res.json({
            online: true,
            totalServers: client.guilds.cache.size,
            totalZones: monitorZones.length,
            uptime: process.uptime()
        });
    });

    // 구역별 실시간 데이터 API
    app.get('/api/zones', validateApiKey, async (req, res) => {
        try {
            const zonesData = await Promise.all(monitorZones.map(async (zone, index) => {
                // 현재 저장된 일치율 가져오기 (없으면 null)
                const matchData = zoneMatchData[zone.name] || null;
                
                return {
                    name: zone.name,
                    tileUrl: zone.tileUrl,
                    wplaceUrl: zone.wplaceUrl,
                    matchPercentage: matchData ? matchData.percentage : null,
                    lastChecked: matchData ? matchData.timestamp : null,
                    threshold: 90,
                    totalPixels: matchData ? matchData.totalPixels : null,
                    matchPixels: matchData ? matchData.matchPixels : null,
                    diffPixels: matchData ? matchData.diffPixels : null
                };
            }));
            
            res.json({
                success: true,
                zones: zonesData,
                lastUpdate: new Date().toISOString()
            });
        } catch (error) {
            console.error('API 오류:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 특정 구역의 최신 이미지 가져오기
    app.get('/api/zone/:zoneName/image', validateApiKey, async (req, res) => {
        try {
            const zoneName = req.params.zoneName;
            const zone = monitorZones.find(z => z.name === zoneName);
            
            if (!zone) {
                return res.status(404).json({ success: false, error: '구역을 찾을 수 없습니다' });
            }
            
            // 실시간 이미지 가져오기
            const response = await axios.get(zone.tileUrl, { responseType: 'arraybuffer' });
            const currentFlagBuffer = await sharp(Buffer.from(response.data))
                .extract({ left: zone.x, top: zone.y, width: zone.width, height: zone.height })
                .toBuffer();
            
            res.set('Content-Type', 'image/png');
            res.send(currentFlagBuffer);
        } catch (error) {
            console.error('이미지 로드 오류:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 일치율 히스토리 API (차트용)
    app.get('/api/zone/:zoneName/history', validateApiKey, (req, res) => {
        const zoneName = req.params.zoneName;
        const history = zoneHistory[zoneName] || [];
        
        res.json({
            success: true,
            zoneName: zoneName,
            history: history.slice(-60) // 최근 60개만 반환
        });
    });
};
