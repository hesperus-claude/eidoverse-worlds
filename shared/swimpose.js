// swimpose — the procedural swim stroke and treading pose, one law for the browser (client/lib/avatar.js _swimLayer) and
// the headless body reader (mcpl/body-state.ts), so read joints are the drawn ones. The clips 'swim' and 'tread' name it.
// The beat runs on each viewer's own clock (not on the wire): PHASE is per viewer, the shape is the same everywhere.

/** The clips this module draws. */
export const SWIM_CLIPS = ['swim', 'tread'];

/** [bone, x, y, z] Euler radians (order 'YZX') per bone, at stroke mix `m` (0 tread, 1 swim) and time `t` s.
 *  Never the head: the camera pitch owns it. */
export function swimTargets(m, t) {
  const ph = t * 2 * Math.PI * (0.6 + 0.25 * m);          // a little brisker when moving
  const S = 0.5 + 0.5 * Math.sin(ph), K = 0.5 + 0.5 * Math.sin(ph + Math.PI);
  const L = (a, b) => a + (b - a) * m;                    // tread → swim
  const mixv = (a, b, k) => a + (b - a) * k;
  return [
    ['hips', L(0.08, 0.55), 0, 0],
    ['spine', L(0, 0.1), 0, 0],
    ['neck', L(0, -0.45), 0, 0],
    ['leftUpperArm', 0, L(0.35 * Math.sin(ph), mixv(-0.2, -1.45, S)), L(-0.55, mixv(-0.6, -0.15, S))],
    ['rightUpperArm', 0, L(-0.35 * Math.sin(ph), mixv(0.2, 1.45, S)), L(0.55, mixv(0.6, 0.15, S))],
    ['leftLowerArm', 0, L(-0.5, mixv(-1.2, -0.1, S)), 0],
    ['rightLowerArm', 0, L(0.5, mixv(1.2, 0.1, S)), 0],
    ['leftUpperLeg', L(-0.45 - 0.25 * Math.sin(ph), -0.5 * K), 0, L(0, 0.25 * K)],
    ['rightUpperLeg', L(-0.45 + 0.25 * Math.sin(ph), -0.5 * K), 0, L(0, -0.25 * K)],
    ['leftLowerLeg', L(0.9 + 0.3 * Math.sin(ph), 1.4 * K), 0, 0],
    ['rightLowerLeg', L(0.9 - 0.3 * Math.sin(ph), 1.4 * K), 0, 0],
  ];
}

// the volume swimmer's pose (a body in a water VOLUME, not the level): absolute normalized XYZ Euler radians.
// Owns shoulders, arms and hands during the stroke: a Z twist on idle folds them back.
export function swimPose(time, surface=false){
 const stroke=.5+.5*Math.sin(time*2.5),kick=Math.sin(time*4);
 const pose={};
 for(const [side,sign] of [['left',1],['right',-1]]){
  pose[side+'Shoulder']=[0,0,0];
  pose[side+'UpperArm']=[0,-sign*(.25+.2*stroke),sign*(surface?-.55-.15*stroke:.25+.65*stroke)];
  pose[side+'LowerArm']=[0,-sign*.25,sign*(.25+.55*(1-stroke))];
  pose[side+'Hand']=[0,0,0];
  pose[side+'UpperLeg']=[sign*.18*kick,0,0];
  pose[side+'LowerLeg']=[Math.max(0,-sign*kick)*.2,0,0];
 }
 return pose;
}
