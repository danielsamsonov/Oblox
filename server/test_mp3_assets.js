'use strict';
const assert=require('node:assert/strict');
const {validateAsset,MAX_ASSET}=require('./asset_validation');

// Silent Layer III frames, encoded here from the MPEG header/side-info format.
// They are also decoded by Godot in the client integration test.
function mp3({version=3,indices=[9],frames=40,id3=false,mono=false,padding=false}={}){
  const tables=version===3?[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]:[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
  const rate=44100/(version===3?1:version===2?2:4),chunks=[];
  if(id3){const text=Buffer.from([0,79,98,108,111,120]);const frame=Buffer.alloc(10+text.length);frame.write('TIT2');frame.writeUInt32BE(text.length,4);text.copy(frame,10);const header=Buffer.from([73,68,51,3,0,0,0,0,0,frame.length]);chunks.push(header,frame);}
  for(let i=0;i<frames;i++){
    const index=indices[i%indices.length];const length=Math.floor((version===3?144000:72000)*tables[index]/rate)+(padding?1:0);
    const frame=Buffer.alloc(length);frame[0]=255;frame[1]=224|(version<<3)|3;frame[2]=(index<<4)|(padding?2:0);frame[3]=mono?192:0;chunks.push(frame);
  }
  return Buffer.concat(chunks);
}
function largeWav(size=40*1024*1024){
  assert(size>=48&&size%4===0);const b=Buffer.alloc(size);b.write('RIFF');b.writeUInt32LE(size-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(2,22);b.writeUInt32LE(44100,24);b.writeUInt32LE(176400,28);b.writeUInt16LE(4,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(size-44,40);return b;
}
module.exports={mp3,largeWav};
if(require.main===module){
  let checks=0;
  for(const options of [{},{id3:true},{indices:[9,10,11,9]},{version:2,indices:[8],mono:true},{version:0,indices:[8]},{padding:true}]){
    const result=validateAsset(mp3(options),'sound','track.mp3');assert.equal(result.format,'mp3');assert.equal(result.mime,'audio/mpeg');checks++;
  }
  const bad=[Buffer.from('ID3 not an MP3 file'),mp3().subarray(0,-1),mp3({frames:1}),Buffer.concat([mp3(),Buffer.from('not a tag')])];
  const malformed=mp3({id3:true});malformed[6]=128;bad.push(malformed);
  const reserved=mp3();reserved[1]=(reserved[1]&~24)|8;bad.push(reserved);
  for(const data of bad){assert.throws(()=>validateAsset(data,'sound','fake.mp3'));checks++;}
  assert.equal(validateAsset(largeWav(MAX_ASSET),'sound','50MiB.wav').size,MAX_ASSET);checks++;
  assert.throws(()=>validateAsset(Buffer.alloc(MAX_ASSET+1),'sound','too-big.wav'),e=>e.status===413);checks++;
  console.log('MP3 AND LARGE LIMITS PASS '+checks+' checks');
}
