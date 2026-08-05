// A valid 68H…16H frame that is NOT CAT-1: the worked example from section
// 3.1.1 of the CJ/T 188 protocol PDF. The decoder for it is gone -- the fleet
// speaks CAT-1 only -- but the frame is kept because it is the one thing that
// proves the two layers below the decoder are protocol-agnostic:
//
//   - the splitter locates it correctly even though its length byte is honest
//     and CAT-1's lies (framing.test.js)
//   - isCat1Frame() rejects it, which is the negative case for the sniffer
//     that decides whether a frame is ours at all (cat1.test.js)
//
// Replacing it with a hand-made buffer would weaken both: this one is real.

export const REFERENCE_FRAME_HEX = [
  '68107545000013082181AC9097002B606620002B308001002B00000000',
  '0000000000350000000092270000000000461404260821200002FFB4001200',
  '0B8986111925301747443008648230479880500104FFFFFF00606620000000',
  '00000000000000000000000000000000000000000000000000000000000000',
  '000000000000000F6E07941D1011621B9F09EB060E079E0D35048759ED00',
  '000D6F07760B7D0A0017FB0F6515C20D0B16450D0B068614D2079500B3',
  '2CD8E616',
].join('');

export const REFERENCE_FRAME = Buffer.from(REFERENCE_FRAME_HEX, 'hex');

// Six frames captured from a real meter pushing raw TCP to port 8505 on
// 2026-08-03. CAT-1 protocol, packet type 03 (postpaid standard report), not
// CJ/T 188 -- byte 10 is the fixed control code 97H, not a length, which is why
// the CJ/T 188 decoder reads them as "L=151, so 164 bytes" and rejects them.
//
// Frames 3-6 were produced by pressing the upload button on the meter, so the
// reporting-type field carries the "trigger" bit and the report counters step
// by one per frame. No water was drawn during the capture, so cumulative usage
// is identical throughout -- that constancy is itself part of the fixture.
export const CAT1_FRAMES_HEX = [
  '6810040022082610000397000000024603C22C002703060300867512079825846D89860422152570' +
    '0097820E1EA2F71700100002C005A0FFFFFF0000000003E80000000000000000230923060246000000' +
    '00000000007416',
  '6810040022082610000397000000024603C22C002703060300867512079825846D89860422152570' +
    '0097820E1EA1F91700110003C005A0FFFFFF0000000003E80000000000000000230923061827000000' +
    '00000000006E16',
  '6810040022082610000397000000024603C22C002703060300867512079825846D89860422152570' +
    '0097820E1AA0F91800120004C005A0FFFFFF0000000003E80000000000000000230923062223000000' +
    '00000000007216',
  '6810040022082610000397000000024603C22C002703060300867512079825846D89860422152570' +
    '0097820E1AA3F91600130005C005A0FFFFFF0000000003E80000000000000000230923062655000000' +
    '0000000000AB16',
  '6810040022082610000397000000024603C22C002703060300867512079825846D89860422152570' +
    '0097820E1AA2F81600140006C005A0FFFFFF0000000003E80000000000000000230923062917000000' +
    '00000000007016',
  '6810040022082610000397000000024603C22C002703060300867512079825846D89860422152570' +
    '0097820E1AA4F91700150007C005A0FFFFFF0000000003E80000000000000000230923062946000000' +
    '0000000000A516',
];

export const CAT1_FRAMES = CAT1_FRAMES_HEX.map((h) => Buffer.from(h, 'hex'));

/** The first of the six, used wherever one representative frame is enough. */
export const CAT1_FRAME = CAT1_FRAMES[0];

/** Confirmed by the operator as the real meter id for these frames. */
export const DEVICE_METER_ADDRESS = '00102608220004';

/** The 6 bytes the same device sends immediately before its first frame. */
export const DEVICE_PREAMBLE = Buffer.from('A345A3C50000', 'hex');
