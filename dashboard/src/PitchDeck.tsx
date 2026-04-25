import React, { useState, useEffect, useCallback } from 'react';

const SLIDES = [
  {
    title: 'The Broken Market',
    content: (
      <div className="space-y-4">
        <p className="text-xl text-gray-200 leading-relaxed">
          270,000+ community weather stations. Tens of thousands of air quality sensors.
          Seismic networks. Radiation networks.
        </p>
        <p className="text-gray-400">
          Commercial platforms monetize without paying contributors.
          Open networks have no sustainability model. Autonomous agents in
          parametric insurance, climate risk, and supply chain need granular
          continuous data that neither serves.
        </p>
        <blockquote className="border-l-4 border-yellow-500 pl-4 mt-6 text-gray-400 italic">
          "So — you are monetizing our data, which we are fine with, but you want us to
          PAY YOU for the luxury of being screwed? Changing your business model to
          'take-and-take' will change our mood to 'don't give — don't take'."
          <cite className="block text-xs text-gray-600 mt-1 not-italic">— Weather Underground forum, sensor owner</cite>
        </blockquote>
      </div>
    ),
  },
  {
    title: 'Cairn: The Protocol',
    content: (
      <div className="space-y-6">
        <p className="text-lg text-gray-300 italic">
          "Permissionless payment protocol for community sensor networks. Operators keep
          100% of their rate. Cairn charges a 2% service fee for discovery, verification,
          and attestation."
        </p>
        <div className="flex items-center justify-center gap-4 text-sm">
          {['Customer Agent', '→', 'Cairn Aggregator', '→', 'Sensor Operators'].map((s, i) => (
            s === '→'
              ? <span key={i} className="text-blue-400 text-2xl">{s}</span>
              : <div key={i} className="bg-border rounded-lg px-4 py-3 text-center">
                  <div className="text-white font-semibold">{s}</div>
                  <div className="text-xs text-gray-500 mt-1">x402</div>
                </div>
          ))}
        </div>
        <div className="flex justify-center gap-8 text-xs text-gray-400">
          <div className="text-center"><div className="text-green-400 font-bold text-lg">100%</div><div>Operator rate</div></div>
          <div className="text-center"><div className="text-blue-400 font-bold text-lg">2%</div><div>Protocol fee</div></div>
          <div className="text-center"><div className="text-purple-400 font-bold text-lg">10 USDC</div><div>Stake per sensor</div></div>
        </div>
      </div>
    ),
  },
  {
    title: 'Why Only Nanopayments',
    content: (
      <div>
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-border text-gray-500 text-xs uppercase">
              <th className="text-left py-2 pr-4">Rail</th>
              <th className="text-left py-2 pr-4">Per-query cost</th>
              <th className="text-left py-2">Verdict</th>
            </tr>
          </thead>
          <tbody className="text-gray-400">
            {[
              ['L1 Ethereum gas',    '$1–5',       '10,000× query value — impossible'],
              ['Stripe',            '$0.30 min',   '3,000× query value — impossible'],
              ['Chainlink enterprise','~$0.50',    '500× + no long-tail onboarding'],
            ].map(([rail, cost, verdict]) => (
              <tr key={rail} className="border-b border-border/50">
                <td className="py-3 pr-4">{rail}</td>
                <td className="py-3 pr-4 text-red-400">{cost}</td>
                <td className="py-3 text-red-400 text-xs">{verdict}</td>
              </tr>
            ))}
            <tr className="bg-green-900/20">
              <td className="py-3 pr-4 font-bold text-green-300">Cairn (Arc + Nanopayments)</td>
              <td className="py-3 pr-4 text-green-400 font-bold">~$0 settlement</td>
              <td className="py-3 text-green-400 font-bold text-xs">Only viable rail ✓</td>
            </tr>
          </tbody>
        </table>
      </div>
    ),
  },
  {
    title: 'Live Demo',
    content: (
      <div className="space-y-4 text-gray-300">
        <code className="block bg-border rounded px-3 py-2 text-green-400 text-sm">
          npm run demo:adversarial
        </code>
        <div className="space-y-3 text-sm">
          {[
            ['1', 'Insurance agent queries 3 sensors via x402 payment'],
            ['2', 'Aggregator pays each operator in nanopayments'],
            ['3', 'Verification engine runs — median + MAD cross-reference'],
            ['4', 'Operator 5 reports anomalous values → reputation decays'],
            ['5', 'Reputation drops below threshold → automatic slash'],
            ['6', 'Honest quorum confirms breach condition'],
            ['7', 'Payout: 10 USDC → policyholder on-chain'],
          ].map(([n, step]) => (
            <div key={n} className="flex gap-3 items-start">
              <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center shrink-0 mt-0.5">{n}</span>
              <span>{step}</span>
            </div>
          ))}
        </div>
      </div>
    ),
  },
  {
    title: 'Business Model & What\'s Next',
    content: (
      <div className="space-y-4">
        <div>
          <div className="text-xs text-gray-500 uppercase tracking-wider mb-2">Revenue ladder</div>
          <div className="space-y-1 text-sm">
            {[
              ['Early',   '50K sensors × 10 q/day × $0.001 × 2%', '$3.6K/yr'],
              ['Mid',     '500K × 100 q/day × $0.001 × 2%',       '$365K/yr'],
              ['Scaled',  '5M × 500 q/day × $0.0005 × 2%',        '$9M/yr'],
            ].map(([stage, calc, rev]) => (
              <div key={stage} className="flex justify-between bg-border/30 rounded px-3 py-1.5">
                <span className="text-gray-400 w-16">{stage}</span>
                <span className="text-gray-500 text-xs">{calc}</span>
                <span className="text-green-400 font-semibold">{rev}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500 uppercase tracking-wider mb-2">Go-to-market partners</div>
          <div className="flex flex-wrap gap-2">
            {[
              ['Sensor.Community', '35K stations'],
              ['Raspberry Shake',  '10K seismic'],
              ['Safecast',         '150M measurements'],
            ].map(([name, stat]) => (
              <div key={name} className="bg-border rounded px-3 py-1.5 text-xs">
                <div className="text-white font-semibold">{name}</div>
                <div className="text-gray-500">{stat}</div>
              </div>
            ))}
          </div>
        </div>
        <p className="text-xs text-gray-500 italic">
          Demo is weather. Protocol is data-type agnostic: air, seismic, radiation already
          in the registry.
        </p>
      </div>
    ),
  },
];

interface Props { onClose: () => void }

export default function PitchDeck({ onClose }: Props) {
  const [slide, setSlide] = useState(0);

  const prev = useCallback(() => setSlide(s => Math.max(0, s - 1)), []);
  const next = useCallback(() => setSlide(s => Math.min(SLIDES.length - 1, s + 1)), []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown')  next();
      if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')    prev();
      if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, prev, onClose]);

  const current = SLIDES[slide];

  return (
    <div className="fixed inset-0 z-50 bg-surface/95 backdrop-blur flex flex-col items-center justify-center p-12">
      {/* Close */}
      <button onClick={onClose} className="absolute top-6 right-8 text-gray-500 hover:text-white text-sm">
        Press P or ESC to exit
      </button>

      {/* Slide counter */}
      <div className="absolute top-6 left-8 text-xs text-gray-600">
        {slide + 1} / {SLIDES.length}
      </div>

      {/* Slide content */}
      <div className="max-w-3xl w-full">
        <div className="text-xs text-blue-500 uppercase tracking-widest mb-3">Cairn Protocol</div>
        <h2 className="text-3xl font-bold text-white mb-6">{current.title}</h2>
        <div>{current.content}</div>
      </div>

      {/* Navigation */}
      <div className="absolute bottom-8 flex items-center gap-6">
        <button
          onClick={prev}
          disabled={slide === 0}
          className="px-4 py-2 rounded bg-border text-gray-300 disabled:opacity-30 hover:bg-gray-700 text-sm"
        >
          ← Prev
        </button>
        <div className="flex gap-2">
          {SLIDES.map((_, i) => (
            <button
              key={i}
              onClick={() => setSlide(i)}
              className="w-2 h-2 rounded-full transition-colors"
              style={{ background: i === slide ? '#3b82f6' : '#374151' }}
            />
          ))}
        </div>
        <button
          onClick={next}
          disabled={slide === SLIDES.length - 1}
          className="px-4 py-2 rounded bg-border text-gray-300 disabled:opacity-30 hover:bg-gray-700 text-sm"
        >
          Next →
        </button>
      </div>
    </div>
  );
}
