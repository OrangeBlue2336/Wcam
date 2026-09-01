const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { AttachmentBuilder, EmbedBuilder } = require('discord.js');

const { RECORD_FPS, DEVELOPER_ID } = require('../config/env');
const monitorZones = require('../config/zones');
const { RecordSession, RecordFrame } = require('../db/models');
const { generateSessionId } = require('../utils/helpers');

// services/recording.js
// 캡처/저장/인코딩 큐 등 녹화(타임랩스) 핵심 로직.
// index.js에서 만들어진 client를 주입받아 사용한다 (require('./services/recording')(client)).
module.exports = (client) => {
    // ========================================
    // 영상 인코딩 대기열 (큐) 설정
    // ========================================
    const encodeQueue = [];
    let isEncoding = false;

    // 작품 녹화 대기 중인 세션 임시 저장 (버튼 확인 전)
    const pendingArtworkRecords = new Map();

// 다중 타일 영역 캡처 함수 (다중_타일_대처.js 로직 적용)
async function captureRegionBuffer(tileX, tileY, localX, localY, width, height) {
    const endAbsX = localX + width - 1;
    const endAbsY = localY + height - 1;
    const etx = tileX + Math.floor(endAbsX / 1000);
    const ety = tileY + Math.floor(endAbsY / 1000);
    const elx = endAbsX % 1000;
    const ely = endAbsY % 1000;

    const stx = tileX, sty = tileY, slx = localX, sly = localY;
    const composites = [];
    let totalWidth = 0, totalHeight = 0;

    for (let tx = stx; tx <= etx; tx++) {
        for (let ty = sty; ty <= ety; ty++) {
            const url = `https://backend.wplace.live/files/s0/tiles/${tx}/${ty}.png`;
            const res = await axios.get(url, { responseType: 'arraybuffer' });

            const cropLeft   = (tx === stx) ? slx : 0;
            const cropTop    = (ty === sty) ? sly : 0;
            const cropRight  = (tx === etx) ? elx : 999;
            const cropBottom = (ty === ety) ? ely : 999;
            const cropW = cropRight - cropLeft + 1;
            const cropH = cropBottom - cropTop + 1;
            if (cropW <= 0 || cropH <= 0) continue;

            const cropped = await sharp(Buffer.from(res.data))
                .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
                .png().toBuffer();

            const posX = (tx - stx) * 1000 + (tx === stx ? 0 : -slx);
            const posY = (ty - sty) * 1000 + (ty === sty ? 0 : -sly);
            composites.push({ input: cropped, left: posX, top: posY });

            if (tx === etx) totalWidth  = posX + cropW;
            if (ty === ety) totalHeight = posY + cropH;
        }
    }

    if (composites.length === 0) throw new Error('캡처 가능한 영역이 없습니다.');

    return await sharp({
        create: { width: totalWidth, height: totalHeight, channels: 4,
                  // 투명 배경을 지정된 색상(#aabdf9)으로 채우고 불투명하게(alpha: 1) 설정
                  background: { r: 170, g: 189, b: 249, alpha: 1 } }
    }).composite(composites).png().toBuffer();
}

// 캡처 및 저장 함수 (중복 프레임 제거 + 다중 타일 지원)
async function captureAndSave(session) {
    try {
        let frameBuffer;

        if (session.sessionType === 'artwork') {
            frameBuffer = await captureRegionBuffer(
                session.tileX, session.tileY,
                session.localX, session.localY,
                session.captureWidth, session.captureHeight
            );
        } else {
            const zone = monitorZones.find(z => z.name === session.zoneName);
            if (!zone) return;
            const response = await axios.get(zone.tileUrl, { responseType: 'arraybuffer' });
            frameBuffer = await sharp(Buffer.from(response.data))
                .extract({ left: zone.x, top: zone.y, width: zone.width, height: zone.height })
                .toBuffer();
        }

        // 작품 녹화(artwork)일 경우에만 중복 프레임 비교 및 스킵
        if (session.sessionType === 'artwork') {
            const lastFrame = await RecordFrame.findOne({ userId: session.userId, sessionType: session.sessionType })
                .sort({ timestamp: -1 }).select('frameData').lean();

            if (lastFrame && lastFrame.frameData) {
                const lastBuf = Buffer.isBuffer(lastFrame.frameData)
                    ? lastFrame.frameData
                    : Buffer.from(lastFrame.frameData.buffer || lastFrame.frameData);
        
                const currentRaw = await sharp(frameBuffer).raw().toBuffer();
                const lastRaw = await sharp(lastBuf).raw().toBuffer();

                if (currentRaw.equals(lastRaw)) {
                    console.log(`⏭️ 중복 프레임 건너뜀 (${session.userId} / ${session.sessionType})`);
                    return;
                }
            }
        }

        await new RecordFrame({
            userId: session.userId,
            sessionType: session.sessionType,
            frameData: frameBuffer
        }).save();

        const newCount = (session.frameCount || 0) + 1;
        await RecordSession.updateOne({ _id: session._id }, { frameCount: newCount });
        console.log(`📸 녹화 ${session.userId}(${session.sessionType}) - ${newCount}프레임 저장됨`);

        // 작품 녹화: 2880 프레임 도달 시 자동 종료
        if (session.sessionType === 'artwork' && newCount >= 2880) {
            const updatedSession = await RecordSession.findOneAndUpdate(
                { _id: session._id },
                { isActive: false },
                { new: true }
            );
            console.log(`🎬 최대 프레임(2880) 도달 - 자동 종료 (${session.userId})`);
            if (updatedSession?.commandChannelId) {
                await createStatusMessageAndFinalize(
                    updatedSession,
                    updatedSession.commandChannelId,
                    "⏹️ 최대 프레임(2880)에 도달하여 녹화를 자동 종료하고 영상을 생성합니다..."
                );
            } else {
                finalizeRecord(session.userId, 'artwork');
            }
        }
    } catch (error) {
        console.error(`❌ 녹화 오류 (${session.userId}):`, error.message);
    }
}

async function finalizeRecord(userId, sessionType = 'flag') {
    // 요청을 큐에 밀어넣고 큐 처리기 실행
    encodeQueue.push({ userId, sessionType });
    console.log(`📥 [인코딩 큐 추가] ${userId} (${sessionType}) - 대기열: ${encodeQueue.length}개`);
    processEncodeQueue();
}

// ── 진행 상황/오류 안내를 DM이 아니라 "채팅 메시지 수정"으로 전달하기 위한 헬퍼들 ──
// DM은 유저 설정에 따라 막혀있을 수 있으므로, 인코딩 진행 상황과 오류(복구 안내 포함)는
// 이 상태 메시지를 통해 전달한다. (완성된 영상 파일 전송만 예외적으로 DM을 사용)

// 특정 세션에 연결된 상태 메시지를 최신 내용으로 수정
async function updateStatusMessage(session, content) {
    if (!session?.statusChannelId || !session?.statusMessageId) return;
    try {
        const channel = await client.channels.fetch(session.statusChannelId);
        const msg = await channel.messages.fetch(session.statusMessageId);
        await msg.edit(content);
    } catch (e) {
        console.error(`상태 메시지 수정 실패 (${session.userId}):`, e.message);
    }
}

// 상호작용(버튼) 없이 자동으로 종료되는 녹화(시간 만료, 최대 프레임 도달, 테스트, 복구 등)를 위해
// 새 상태 메시지를 보내고 세션에 연결한 뒤 인코딩을 큐에 넣는다.
async function createStatusMessageAndFinalize(session, channelId, initialContent) {
    try {
        const channel = await client.channels.fetch(channelId);
        const msg = await channel.send(initialContent);
        await RecordSession.updateOne(
            { _id: session._id },
            { statusChannelId: channel.id, statusMessageId: msg.id }
        );
    } catch (e) {
        console.error(`상태 메시지 생성 실패 (${session.userId}):`, e.message);
    }
    finalizeRecord(session.userId, session.sessionType);
}

async function processEncodeQueue() {
    // 이미 인코딩 중이거나 대기열이 비어있으면 조용히 대기
    if (isEncoding || encodeQueue.length === 0) return;
    isEncoding = true;

    const { userId, sessionType } = encodeQueue.shift();
    console.log(`▶️ [인코딩 시작] ${userId}(${sessionType}) 처리 중...`);

    try {
        // 이름을 바꾼 실제 인코딩 함수 호출
        await performFinalizeRecord(userId, sessionType);
    } catch (error) {
        console.error(`❌ [인코딩 프로세스 오류] ${userId}:`, error);
    }

    // 인코딩 완료 후 서버 메모리/CPU 열을 식히기 위해 30초 대기
    console.log(`⏳ [인코딩 대기] 서버 부하 방지를 위해 30초 대기합니다... (남은 대기열: ${encodeQueue.length}개)`);
    setTimeout(() => {
        isEncoding = false;
        processEncodeQueue(); // 대기열에 남은 게 있는지 다시 확인
    }, 30000); // 30초
}

async function performFinalizeRecord(userId, sessionType = 'flag') {
    const session = await RecordSession.findOne({ userId, sessionType });
    if (!session) return;

    // 임시 작업 디렉토리 생성
    const tmpDir = path.join(os.tmpdir(), `record_${userId}_${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
        const totalFrames = await RecordFrame.countDocuments({ userId, sessionType });
        const user = await client.users.fetch(userId);

        if (totalFrames === 0) {
            await updateStatusMessage(session, "⚠️ 녹화된 프레임이 없어 영상을 생성할 수 없습니다.");
            await cleanupRecord(userId, sessionType);
            return;
        }

        // 표시할 이름과 파일명 접두사 설정
        const displayTitle = session.sessionType === 'artwork' ? '작품 타임랩스' : session.zoneName;
        const filePrefix = session.sessionType === 'artwork' ? 'artwork_timelapse' : `record_${session.zoneName}`;

        console.log(`🎞️ [MP4 생성 시작] ${userId} - 총 ${totalFrames}프레임`);
        await updateStatusMessage(session, `⏳ **${displayTitle}** 영상 생성을 시작합니다... (총 ${totalFrames}프레임)\n프레임 수가 많을 경우 시간이 걸릴 수 있습니다.`);

        // 프레임을 50개씩 꺼내서 임시 폴더에 PNG 파일로 저장
        const frameIds = await RecordFrame.find({ userId, sessionType })
            .sort({ timestamp: 1 })
            .select('_id')
            .lean();

        const CHUNK_SIZE = 50;
        let frameIndex = 0;

        for (let i = 0; i < frameIds.length; i += CHUNK_SIZE) {
            const chunkIds = frameIds.slice(i, i + CHUNK_SIZE).map(f => f._id);
            const chunk = await RecordFrame.find({ _id: { $in: chunkIds } })
                .sort({ timestamp: 1 })
                .lean();

            for (const frame of chunk) {
                // %05d 형식으로 파일명 지정 (ffmpeg가 순서대로 읽기 위함)
                const framePath = path.join(tmpDir, `frame_${String(frameIndex).padStart(5, '0')}.png`);
                fs.writeFileSync(framePath, Buffer.from(frame.frameData.buffer || frame.frameData));
                frame.frameData = null; // 즉시 메모리 해제
                frameIndex++;
            }

            console.log(`📁 [프레임 저장] ${userId} - ${frameIndex}/${totalFrames}`);
        }

        // ffmpeg로 MP4 인코딩 (디스크에서 읽어서 디스크에 씀 → 메모리 거의 안 씀)
        const outputPath = path.join(tmpDir, 'output.mp4');
        const inputPattern = path.join(tmpDir, 'frame_%05d.png');

        // 유동적 프레임레이트 계산
        let currentFps = RECORD_FPS; // 기본 30FPS
        if (totalFrames < 60) {
            currentFps = 10;
        } else if (totalFrames < 150) {
            currentFps = 15;
        }
        console.log(`🎞️ [MP4 프레임레이트] 총 ${totalFrames}프레임 -> ${currentFps}FPS 적용`);

        await new Promise((resolve, reject) => {
            const ffmpeg = spawn('ffmpeg', [
                '-framerate', String(currentFps), // 계산된 FPS 적용
                '-i', inputPattern,
                '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', // 가로/세로가 홀수인 경우 짝수로 패딩
                '-c:v', 'libx264',       // H.264 코덱
                '-pix_fmt', 'yuv420p',   // 호환성 최대화
                '-preset', 'fast',        // 인코딩 속도/압축 균형
                '-crf', '17',            // 화질 (낮을수록 좋음, 18~28 권장)
                outputPath
            ]);

            ffmpeg.stderr.on('data', (data) => {
                console.log(`ffmpeg: ${data}`);
            });

            ffmpeg.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`ffmpeg 종료 코드: ${code}`));
            });
        });

        console.log(`✅ [MP4 인코딩 완료] ${userId}`);

        // Discord 파일 크기 제한 확인 (무료: 25MB)
        const stats = fs.statSync(outputPath);
        const fileSizeMB = stats.size / (1024 * 1024);

        if (fileSizeMB > 24) {
            console.log(`⚠️ [MP4 용량 초과] ${userId} - ${fileSizeMB.toFixed(1)}MB. 재압축 시도.`);
            await updateStatusMessage(session, `⚠️ 영상 용량이 커서(${fileSizeMB.toFixed(1)}MB) 전송 한도를 초과했습니다. 화질을 낮춰 재압축을 시도합니다. 잠시만 기다려주세요...`);

            const compressedOutputPath = path.join(tmpDir, 'output_compressed.mp4');

            // CRF 값을 26으로 높여서(화질 감소, 용량 대폭 감소) 재압축
            await new Promise((resolve, reject) => {
                const reEncode = spawn('ffmpeg', [
                    '-i', outputPath,
                    '-c:v', 'libx264',
                    '-preset', 'fast',
                    '-crf', '26', // 화질을 더 낮춰서 용량을 더 줄임
                    compressedOutputPath
                ]);

                reEncode.on('close', (code) => {
                    if (code === 0) resolve();
                    else reject(new Error(`재압축 ffmpeg 종료 코드: ${code}`));
                });
            });

            const newStats = fs.statSync(compressedOutputPath);
            const newFileSizeMB = newStats.size / (1024 * 1024);

            if (newFileSizeMB > 24) {
                // 재압축 후에도 24MB를 넘으면 최종 포기
                await updateStatusMessage(session,
                    `❌ 재압축을 진행했으나 파일이 여전히 너무 큽니다(${newFileSizeMB.toFixed(1)}MB).\n` +
                    `녹화 시간을 조금 더 짧게 설정해주세요.`
                );
                await cleanupRecord(userId, sessionType);
                return;
            } else {
                // 재압축 성공 시 전송 (파일 전송은 원 녹화자에게만 DM으로)
                const attachment = new AttachmentBuilder(compressedOutputPath, { name: `${filePrefix}_compressed.mp4` });
                try {
                    await user.send({
                        content: `✅ **${displayTitle}** 녹화가 완료되었습니다! (압축됨, ${newFileSizeMB.toFixed(1)}MB)`,
                        files: [attachment]
                    });
                } catch (dmErr) {
                    throw new Error(`DM_SEND_FAILED:${dmErr.message}`);
                }
                console.log(`✅ [MP4 재압축 전송 완료] ${userId}`);
                await updateStatusMessage(session, `✅ **${displayTitle}** 녹화가 완료되어 DM으로 전송되었습니다! (압축됨, ${newFileSizeMB.toFixed(1)}MB)`);
            }
        } else {
            // 원본이 24MB 이하일 경우 정상 전송 (파일 전송은 원 녹화자에게만 DM으로)
            const attachment = new AttachmentBuilder(outputPath, { name: `${filePrefix}.mp4` });
            try {
                await user.send({
                    content: `✅ **${displayTitle}** 녹화가 완료되었습니다! (총 ${totalFrames}프레임, ${fileSizeMB.toFixed(1)}MB)`,
                    files: [attachment]
                });
            } catch (dmErr) {
                throw new Error(`DM_SEND_FAILED:${dmErr.message}`);
            }
            console.log(`✅ [MP4 전송 완료] ${userId}`);
            await updateStatusMessage(session, `✅ **${displayTitle}** 녹화가 완료되어 DM으로 전송되었습니다! (총 ${totalFrames}프레임, ${fileSizeMB.toFixed(1)}MB)`);
        }

        // ── 작품 녹화 완료 시 개발자에게 사본 전송 ──────────────────
        if (sessionType === 'artwork' && DEVELOPER_ID && userId !== DEVELOPER_ID) {
            try {
                const developer = await client.users.fetch(DEVELOPER_ID);
                const devAttachment = new AttachmentBuilder(
                    fs.existsSync(path.join(tmpDir, 'output_compressed.mp4'))
                        ? path.join(tmpDir, 'output_compressed.mp4')
                        : outputPath,
                    { name: `dev_copy_${filePrefix}.mp4` }
                );
                const devEmbed = new EmbedBuilder()
                    .setTitle('🎬 작품 타임랩스 완료 알림 (개발자 사본)')
                    .setColor(0x5865F2)
                    .addFields(
                        { name: '유저 ID', value: `\`${userId}\``, inline: true },
                        { name: '유저명', value: user.tag, inline: true },
                        { name: '총 프레임', value: `${totalFrames}프레임`, inline: true },
                        { name: '파일 크기', value: `${fileSizeMB.toFixed(1)}MB`, inline: true },
                        { name: '녹화 영역', value: `타일 (${session.tileX}, ${session.tileY}), 로컬 (${session.localX}, ${session.localY})`, inline: false },
                        { name: '캡처 크기', value: `${session.captureWidth} × ${session.captureHeight}px`, inline: true }
                    )
                    .setTimestamp();
                await developer.send({ embeds: [devEmbed], files: [devAttachment] });
                console.log(`📨 [개발자 사본 전송] ${userId}(${user.tag})의 작품 타임랩스`);
            } catch (devErr) {
                console.error('개발자 사본 전송 실패:', devErr.message);
            }
        }

        // ✅ 여기까지 도달했다면 영상 생성 및 전송이 모두 성공한 것 → 이때만 프레임/세션 삭제
        await cleanupRecord(userId, sessionType);

    } catch (error) {
        // ❌ 인코딩, 전송(DM 실패 등), 그 외 어떤 오류든 여기서 잡힘
        // → 프레임과 세션은 절대 삭제하지 않고 needsRecovery 플래그만 세워서 보존한다.
        console.error(`❌ [MP4 생성 오류] ${userId}:`, error);
        try {
            await RecordSession.updateOne({ _id: session._id }, { needsRecovery: true, isActive: false });
        } catch (dbErr) {
            console.error('needsRecovery 플래그 저장 실패:', dbErr);
        }

        const recoveryId = session.sessionId || '(ID 없음 - 개발자 문의 필요)';
        const isDmFail = typeof error.message === 'string' && error.message.startsWith('DM_SEND_FAILED');

        // ⚠️ DM으로 안내하지 않는다 (DM이 막혀있을 수 있으므로).
        // 대신 "녹화를 중지하고 영상을 생성합니다..." 메시지를 그대로 수정해서 안내한다.
        const errorNotice = isDmFail
            ? `❌ 영상 생성은 완료됐지만 **DM 전송에 실패**했습니다. (DM이 막혀있을 수 있습니다)\n` +
              `설정에서 서버 멤버의 DM 수신을 허용한 뒤 아래 명령어로 다시 시도해주세요.`
            : `❌ 영상 생성 중 오류가 발생했습니다. (${error.message})`;

        await updateStatusMessage(session,
            `${errorNotice}\n` +
            `✅ 녹화된 프레임은 삭제되지 않고 안전하게 보존되었습니다.\n\n` +
            `🔁 아래 명령어로 언제든 다시 시도할 수 있습니다:\n` +
            `\`w!record recover ${recoveryId}\``
        );
    } finally {
        // 임시 작업 폴더(디스크에 잠깐 풀어놓은 PNG들)만 삭제. 원본 프레임은 DB에 그대로 남아있음.
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (e) {
            console.error('임시 파일 삭제 실패:', e);
        }
    }
}

async function cleanupRecord(userId, sessionType = 'flag') {
    await RecordSession.deleteOne({ userId, sessionType });
    await RecordFrame.deleteMany({ userId, sessionType });
}

// 이번 업데이트 이전(sessionId 필드가 없던 시절)에 시작된 녹화 세션에도
// ID를 부여해서, 재시작 이후 오류가 나도 w!record recover로 복구 가능하게 한다.
async function migrateLegacySessionIds() {
    try {
        const legacySessions = await RecordSession.find({
            $or: [{ sessionId: { $exists: false } }, { sessionId: null }, { sessionId: '' }]
        });

        for (const s of legacySessions) {
            s.sessionId = generateSessionId();
            await s.save();
            console.log(`🆔 [세션 ID 부여] ${s.userId}(${s.sessionType}) → ${s.sessionId}`);
        }

        if (legacySessions.length > 0) {
            console.log(`🆔 [마이그레이션 완료] 기존 세션 ${legacySessions.length}개에 ID 부여됨`);
        }
    } catch (e) {
        console.error('세션 ID 마이그레이션 실패:', e);
    }
}

async function processRecordings() {

    const now = new Date();
    const activeSessions = await RecordSession.find({ isActive: true });

    for (const session of activeSessions) {
        // 태극기 녹화: 시간 기반 자동 종료
        if (session.sessionType === 'flag' && session.endTime && now >= session.endTime) {
            const updatedSession = await RecordSession.findOneAndUpdate(
                { _id: session._id },
                { isActive: false },
                { new: true }
            );
            if (updatedSession?.commandChannelId) {
                await createStatusMessageAndFinalize(
                    updatedSession,
                    updatedSession.commandChannelId,
                    "⏹️ 녹화 시간이 종료되어 영상을 생성합니다..."
                );
            } else {
                finalizeRecord(session.userId, 'flag');
            }
            continue;
        }
        await captureAndSave(session);
    }
}

    return {
        captureRegionBuffer,
        captureAndSave,
        finalizeRecord,
        updateStatusMessage,
        createStatusMessageAndFinalize,
        processEncodeQueue,
        performFinalizeRecord,
        cleanupRecord,
        migrateLegacySessionIds,
        processRecordings,
        encodeQueue,
        pendingArtworkRecords
    };
};
