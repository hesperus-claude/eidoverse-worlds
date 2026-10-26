# docs/research

Design rationale and surveys: why a piece of the engine is built the way it is, and what was tried and rejected. These
notes explain; they don't bind. A rule other code or worlds rely on lives in a contract doc under `docs/` or `spec/`.
Measurement logs stay in git history; a note keeps a number only where a current constant rests on it.

**Bodies and physics**
- [ammodoll-port.md](ammodoll-port.md): the Bullet body engine, what transfers from the source, its structural laws
- [ragdoll-tuning.md](ragdoll-tuning.md): wing tension, damping and ramp
- [ragdoll-sync.md](ragdoll-sync.md): one owner simulates, drags are a takeover, headless bodies run the same solver in world coordinates
- [leaf-flutter.md](leaf-flutter.md): forces on the real ragdoll instead of kinematics
- [body-scale-vr.md](body-scale-vr.md): the wearer's size and the VR rig composition
- [arm-ik.md](arm-ik.md): the swivel-solver port
- [seat-clip-delta.md](seat-clip-delta.md): the seated clip's hips offset

**Rendering**
- [governor.md](governor.md): the two-way quality ladder
- [lightrig-slots.md](lightrig-slots.md): the fixed light-slot topology
- [chest-lamp-shadow.md](chest-lamp-shadow.md): the chest lamp's shadow values
- [material-factory.md](material-factory.md): wrapping materials at creation
- [shadow-depth-prewarm.md](shadow-depth-prewarm.md): how three keys depth pipelines, and the restore trap
- [baked-sky.md](baked-sky.md): clouds as a baked texture
- [grass-tiling-lod.md](grass-tiling-lod.md): grass tiling, the shared program, distance density
- [lod-simplify.md](lod-simplify.md): attribute-aware LOD simplification
- [particlesim-godot-port.md](particlesim-godot-port.md): where the particle sim diverges from Godot

**Sound, voice and captions**
- [sound-realizer.md](sound-realizer.md): the browser's `sound` realizer
- [piper-latency.md](piper-latency.md): Piper in the browser
- [voice-sources.md](voice-sources.md): the TTS seam and the mic's DSP
- [android-captions.md](android-captions.md): speech-to-text on phones
- [captionbot-delivery.md](captionbot-delivery.md): captionbot receipts, order, backpressure, spool
- [sfu-p2p-offload.md](sfu-p2p-offload.md): the SFU hot path, voice-last ordering, where P2P would plug in
- [cross-origin-isolation.md](cross-origin-isolation.md): COOP/COEP and the cross-origin audit

**Agents, protocol and tools**
- [deck-fill-survey.md](deck-fill-survey.md): when a model's top surface is believed as a floor
- [storey-support.md](storey-support.md): which floor the feet stand on
- [motion.md](motion.md): motion as parameters, never frames
- [name-escaping.md](name-escaping.md): the engine-name mapping and where it isn't injective
- [script-audit-soundness.md](script-audit-soundness.md): what a reader's audit can prove
- [clock-offset.md](clock-offset.md): the server clock offset
- [nameplates.md](nameplates.md): where a nameplate hangs and how big it is
- [typing-dots-probe.md](typing-dots-probe.md): how the typing-dots probe judges
