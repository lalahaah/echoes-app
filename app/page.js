"use client";
import React, { useState, useEffect } from 'react';
import { signInAnonymously, onAuthStateChanged, signInWithCustomToken } from 'firebase/auth';
import { collection, addDoc, onSnapshot, serverTimestamp, doc, deleteDoc } from 'firebase/firestore';
import { BookHeart, Loader2, Mic, Square, AlertCircle, MessageSquare, Sparkles, CheckCircle2, Trash2, Clock, CalendarDays } from 'lucide-react';
import { auth, db } from '../lib/firebase';

const SpeechRecognition = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
const recognition = SpeechRecognition ? new SpeechRecognition() : null;
if (recognition) {
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'ko-KR';
}

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  
  // 상태 관리 (글쓰기 플로우)
  const [step, setStep] = useState('idle'); // idle -> recording -> raw_done -> processing -> done -> saving
  const [rawText, setRawText] = useState("");
  const [interimText, setInterimText] = useState("");
  const [refinedText, setRefinedText] = useState("");
  const [tags, setTags] = useState([]);
  const [errorMsg, setErrorMsg] = useState("");

  // 상태 관리 (피드 데이터)
  const [diaries, setDiaries] = useState([]);
  const [feedLoading, setFeedLoading] = useState(true);

  const appId = process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "echoes-app";

  // 자동 인증 로그인
  useEffect(() => {
    const initAuth = async () => {
      try {
        if (typeof window !== 'undefined' && typeof window.__initial_auth_token !== 'undefined' && window.__initial_auth_token) {
          await signInWithCustomToken(auth, window.__initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (error) {
        console.error("Auth Error:", error);
        setLoading(false);
      }
    };
    initAuth();
    const unsubscribe = onAuthStateChanged(auth, setUser);
    return () => unsubscribe();
  }, []);

  // [D+4 핵심] Firestore에서 내 일기 실시간으로 불러오기
  useEffect(() => {
    if (!user) return; 
    
    // 나의 프라이빗 데이터 경로
    const diariesRef = collection(db, 'artifacts', appId, 'users', user.uid, 'diaries');
    
    const unsubscribe = onSnapshot(diariesRef, 
      (snapshot) => {
        const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        // 최신순 정렬 (인메모리 방식)
        docs.sort((a, b) => {
          const timeA = a.createdAt?.toMillis() || 0;
          const timeB = b.createdAt?.toMillis() || 0;
          return timeB - timeA; 
        });
        setDiaries(docs);
        setFeedLoading(false);
      }, 
      (error) => {
        console.error("DB 불러오기 에러:", error);
        setErrorMsg("일기장을 불러오지 못했습니다.");
        setFeedLoading(false);
      }
    );

    return () => unsubscribe();
  }, [user, appId]);

  // Web Speech API 리스너
  useEffect(() => {
    if (!recognition) return;
    recognition.onresult = (event) => {
      let finalTranscript = '';
      let currentInterim = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) finalTranscript += event.results[i][0].transcript;
        else currentInterim += event.results[i][0].transcript;
      }
      if (finalTranscript) setRawText((prev) => prev + finalTranscript + ' ');
      setInterimText(currentInterim);
    };
    recognition.onerror = (event) => {
      setErrorMsg(`마이크 오류 (${event.error})`);
      setStep('raw_done');
    };
  }, []);

  const handleStartRecording = () => {
    if (!recognition) return setErrorMsg("이 브라우저는 음성 인식을 지원하지 않습니다.");
    setErrorMsg(""); setRawText(""); setRefinedText(""); setTags([]);
    try { recognition.start(); setStep('recording'); } catch (e) { console.error(e); }
  };

  const handleStopRecording = () => {
    if (recognition) recognition.stop();
    setStep('raw_done'); setInterimText('');
  };

  // Gemini API 연동 (AI 윤문)
  const processWithAI = async () => {
    if (!rawText.trim()) return;
    setStep('processing');
    try {
      const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY || ""; 
      const systemPrompt = `당신은 초중학생 자녀를 둔 따뜻하고 관조적인 성향의 부모를 위한 '다이어리 대필 작가'입니다.
      아래의 거친 음성 메모를 3~4문장의 감동적이고 정돈된 에세이 톤으로 윤문해 주세요. 
      그리고 글의 감정이나 상황을 나타내는 해시태그 2~3개를 반드시 제공해 주세요.`;

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: rawText }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: { refined_text: { type: "STRING" }, emotion_tags: { type: "ARRAY", items: { type: "STRING" } } }
            }
          }
        })
      });

      const data = await response.json();
      const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (resultText) {
        const parsed = JSON.parse(resultText);
        setRefinedText(parsed.refined_text); setTags(parsed.emotion_tags); setStep('done');
      } else throw new Error("AI 응답 비어있음");
    } catch (error) {
      console.error(error);
      setErrorMsg("AI 처리 중 오류가 발생했습니다."); setStep('raw_done');
    }
  };

  // [D+4 핵심] DB에 일기 저장하기
  const saveDiaryToDB = async () => {
    if (!user || !refinedText) return;
    setStep('saving');
    try {
      const diariesRef = collection(db, 'artifacts', appId, 'users', user.uid, 'diaries');
      await addDoc(diariesRef, {
        rawText: rawText.trim(),
        refinedText: refinedText.trim(),
        tags: tags,
        createdAt: serverTimestamp() // 안전한 서버 시간
      });
      // 저장 완료 후 상태 초기화 (메인 화면으로 복귀)
      setStep('idle');
      setRawText(""); setRefinedText(""); setTags([]);
    } catch (error) {
      console.error("DB 저장 에러:", error);
      setErrorMsg("저장에 실패했습니다.");
      setStep('done');
    }
  };

  // [D+4 핵심] 일기 삭제하기
  const deleteDiary = async (id) => {
    if (!user) return;
    try {
      if(window.confirm("이 기록을 삭제하시겠습니까?")) {
        await deleteDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'diaries', id));
      }
    } catch (error) {
      console.error("삭제 에러:", error);
    }
  };

  // 날짜 포맷팅 함수
  const formatDate = (timestamp) => {
    if (!timestamp) return '방금 전';
    const d = timestamp.toDate();
    return `${d.getMonth() + 1}월 ${d.getDate()}일`;
  };

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4 font-sans text-slate-800">
      <div className="w-full max-w-md bg-white h-[800px] max-h-[90vh] rounded-3xl shadow-2xl overflow-hidden flex flex-col relative border border-slate-200">
        
        {/* 헤더 */}
        <header className="px-6 py-5 border-b border-slate-100 flex justify-between items-center bg-white/80 backdrop-blur-md z-10 shrink-0">
          <div className="flex items-center gap-2">
            <BookHeart className="text-indigo-600 w-6 h-6" />
            <h1 className="text-xl font-bold bg-gradient-to-r from-indigo-600 to-purple-500 bg-clip-text text-transparent">Echoes</h1>
          </div>
          {user && (
            <div className="flex items-center gap-1.5 px-3 py-1 bg-emerald-50 text-emerald-700 rounded-full text-xs font-bold shadow-sm">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              ID: {user.uid.substring(0, 5)}...
            </div>
          )}
        </header>

        {/* 메인 콘텐츠 (작성 영역 + 피드 영역) */}
        <main className="flex-1 overflow-y-auto bg-slate-50 relative pb-32">
          
          {/* [1] 작성 영역 */}
          <div className="p-6 bg-white border-b border-slate-100 shadow-sm rounded-b-3xl relative z-10">
            {errorMsg && (
              <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-xl text-xs flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> <p>{errorMsg}</p>
              </div>
            )}

            {step === 'idle' && (
              <div className="py-8 flex flex-col items-center justify-center text-center opacity-80">
                <MessageSquare className="w-12 h-12 text-slate-300 mb-3" />
                <h2 className="text-base font-semibold text-slate-700">오늘의 감정을 남겨주세요</h2>
                <p className="text-xs text-slate-400 mt-1">하단의 마이크를 눌러 편하게 말씀해 보세요.</p>
              </div>
            )}

            {(step !== 'idle' && rawText) && (
              <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 mb-3 animate-in fade-in duration-300">
                <h3 className="text-[10px] font-bold text-slate-400 mb-2 uppercase">원본 기록</h3>
                <p className="text-sm text-slate-600 italic leading-relaxed">&quot;{rawText}<span className="text-indigo-400">{interimText}</span>&quot;</p>
              </div>
            )}

            {step === 'processing' && (
              <div className="flex items-center gap-2 p-3 bg-indigo-50 text-indigo-700 rounded-xl animate-pulse mt-2">
                <Sparkles className="w-4 h-4 animate-spin-slow" /> <span className="text-xs font-bold">AI가 예쁘게 다듬는 중...</span>
              </div>
            )}

            {step === 'saving' && (
              <div className="flex items-center gap-2 p-3 bg-slate-100 text-slate-600 rounded-xl animate-pulse mt-2">
                <Loader2 className="w-4 h-4 animate-spin" /> <span className="text-xs font-bold">일기장에 보관 중...</span>
              </div>
            )}

            {(step === 'done' && refinedText) && (
              <div className="bg-indigo-50/50 p-4 rounded-xl border border-indigo-100 animate-in fade-in mt-2">
                <div className="flex items-center gap-2 mb-2 text-indigo-600">
                  <Sparkles className="w-4 h-4" /> <span className="text-xs font-bold">AI 교정 완료</span>
                </div>
                <p className="text-sm leading-relaxed text-slate-800 font-medium mb-3 whitespace-pre-wrap">{refinedText}</p>
                <div className="flex flex-wrap gap-1.5">
                  {tags.map((tag, idx) => (
                    <span key={idx} className="px-2 py-1 bg-white text-indigo-600 text-[10px] font-bold rounded-md shadow-sm border border-indigo-100">{tag}</span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* [2] 피드 (Feed) 영역 */}
          <div className="p-6">
            <div className="flex items-center gap-2 mb-4 text-slate-500 px-2">
              <CalendarDays className="w-4 h-4" />
              <h3 className="text-xs font-bold uppercase tracking-wider">나의 에코즈</h3>
            </div>

            {feedLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="w-6 h-6 text-slate-300 animate-spin" />
              </div>
            ) : diaries.length === 0 ? (
              <div className="text-center py-12 text-slate-400">
                <p className="text-sm border border-dashed border-slate-200 py-6 rounded-xl bg-slate-50">아직 기록된 일기가 없습니다.<br/>첫 번째 추억을 남겨보세요!</p>
              </div>
            ) : (
              <div className="space-y-4">
                {diaries.map((diary) => (
                  <div key={diary.id} className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100 group transition-all hover:shadow-md">
                    <div className="flex justify-between items-start mb-3">
                      <div className="flex items-center gap-1.5 text-slate-400">
                        <Clock className="w-3.5 h-3.5" />
                        <span className="text-[11px] font-semibold">{formatDate(diary.createdAt)}</span>
                      </div>
                      <button onClick={() => deleteDiary(diary.id)} className="text-slate-300 hover:text-red-500 transition-colors">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    
                    <p className="text-sm text-slate-800 leading-relaxed font-medium mb-4 whitespace-pre-wrap">{diary.refinedText}</p>
                    
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {diary.tags?.map((tag, idx) => (
                        <span key={idx} className="px-2 py-1 bg-slate-50 text-slate-500 text-[10px] font-bold rounded-md border border-slate-100">{tag}</span>
                      ))}
                    </div>

                    <details className="mt-2 text-xs">
                      <summary className="text-slate-400 cursor-pointer font-medium hover:text-indigo-500 select-none">원본 보기</summary>
                      <p className="mt-2 p-3 bg-slate-50 rounded-lg text-slate-500 italic leading-relaxed whitespace-pre-wrap">&quot;{diary.rawText}&quot;</p>
                    </details>
                  </div>
                ))}
              </div>
            )}
          </div>
        </main>

        {/* 하단 액션 버튼 */}
        <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-white via-white/90 to-transparent pt-12 flex justify-center z-20 pointer-events-none">
          <div className="pointer-events-auto w-full flex justify-center max-w-sm mx-auto gap-3">
            
            {step === 'idle' && (
              <button onClick={handleStartRecording} className="w-16 h-16 bg-indigo-600 rounded-full flex items-center justify-center shadow-[0_8px_30px_rgb(79,70,229,0.4)] hover:scale-105 transition-all">
                <Mic className="w-8 h-8 text-white" />
              </button>
            )}

            {step === 'recording' && (
              <button onClick={handleStopRecording} className="w-16 h-16 bg-rose-500 rounded-full flex items-center justify-center shadow-[0_8px_30px_rgb(225,29,72,0.4)] hover:scale-105 transition-all animate-pulse">
                <Square className="w-6 h-6 text-white" />
              </button>
            )}

            {step === 'raw_done' && rawText && (
              <button onClick={processWithAI} className="w-full py-4 bg-indigo-600 text-white rounded-xl font-bold shadow-lg hover:bg-indigo-700 transition-colors flex items-center justify-center gap-2 animate-in slide-in-from-bottom-2">
                <Sparkles className="w-5 h-5" /> AI로 다듬기
              </button>
            )}

            {step === 'done' && (
              <>
                <button onClick={() => setStep('idle')} className="flex-1 py-4 bg-slate-200 text-slate-700 rounded-xl font-bold hover:bg-slate-300 transition-colors">
                  취소
                </button>
                <button onClick={saveDiaryToDB} className="flex-[2] py-4 bg-slate-900 text-white rounded-xl font-bold shadow-lg hover:bg-black flex items-center justify-center gap-2">
                  <CheckCircle2 className="w-5 h-5" /> 내 일기장에 저장
                </button>
              </>
            )}
          </div>
        </div>
      </div>
      <style dangerouslySetInnerHTML={{__html: `.animate-spin-slow { animation: spin 3s linear infinite; } details > summary { list-style: none; } details > summary::-webkit-details-marker { display: none; }`}} />
    </div>
  );
}
