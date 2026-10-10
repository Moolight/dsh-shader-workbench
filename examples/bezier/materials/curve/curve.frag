#version 300 es
precision highp float;
precision highp int;

uniform vec3 iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform vec4 iMouse;
uniform vec4 iDate;
uniform vec2 uP0;
uniform vec2 uP1;
uniform vec2 uP2;
uniform vec2 uP3;

out vec4 st_fragColor;



void main() {
  vec4 n_n_mv2msx7n51kbv = vec4((vec4((uP0).x, (uP0).y, 0.0, 1.0)).xy, (vec4((uP1).x, (uP1).y, 0.0, 1.0)).xy);
  vec4 n_n_mv2msx7n3vquy = vec4((vec4((uP2).x, (uP2).y, 0.0, 1.0)).xy, (vec4((uP3).x, (uP3).y, 0.0, 1.0)).xy);
  vec4 n_n_mv2msx7n7voep = vec4(9.0);
  float n_n_mv2msx7n08yx3_c_n_best = (n_n_mv2msx7n7voep).x;
  for (int n_n_mv2msx7n08yx3_i = 0; n_n_mv2msx7n08yx3_i < 24; n_n_mv2msx7n08yx3_i++) {
    vec4 n_n_mv2msx7n08yx3_t0n = vec4((vec4(float(n_n_mv2msx7n08yx3_i))).x / 24.0, 0.0, 0.0, 1.0);
    vec4 n_n_mv2msx7n08yx3_pack01 = vec4((vec4((uP0).x, (uP0).y, 0.0, 1.0)).xy, (vec4((uP1).x, (uP1).y, 0.0, 1.0)).xy);
    vec4 n_n_mv2msx7n08yx3_pack23 = vec4((vec4((uP2).x, (uP2).y, 0.0, 1.0)).xy, (vec4((uP3).x, (uP3).y, 0.0, 1.0)).xy);
    vec4 n_n_mv2msx7n08yx3_pa = vec4(((1.0 - ((n_n_mv2msx7n08yx3_t0n).x)) * (1.0 - ((n_n_mv2msx7n08yx3_t0n).x)) * (1.0 - ((n_n_mv2msx7n08yx3_t0n).x)) * (n_n_mv2msx7n08yx3_pack01).xy) + (3.0 * (1.0 - ((n_n_mv2msx7n08yx3_t0n).x)) * (1.0 - ((n_n_mv2msx7n08yx3_t0n).x)) * ((n_n_mv2msx7n08yx3_t0n).x) * (n_n_mv2msx7n08yx3_pack01).zw) + (3.0 * (1.0 - ((n_n_mv2msx7n08yx3_t0n).x)) * ((n_n_mv2msx7n08yx3_t0n).x) * ((n_n_mv2msx7n08yx3_t0n).x) * (n_n_mv2msx7n08yx3_pack23).xy) + (((n_n_mv2msx7n08yx3_t0n).x) * ((n_n_mv2msx7n08yx3_t0n).x) * ((n_n_mv2msx7n08yx3_t0n).x) * (n_n_mv2msx7n08yx3_pack23).zw), 0.0, 1.0);
    vec4 n_n_mv2msx7n08yx3_t1n = vec4(((vec4(float(n_n_mv2msx7n08yx3_i))).x + 1.0) / 24.0, 0.0, 0.0, 1.0);
    vec4 n_n_mv2msx7n08yx3_pb = vec4(((1.0 - ((n_n_mv2msx7n08yx3_t1n).x)) * (1.0 - ((n_n_mv2msx7n08yx3_t1n).x)) * (1.0 - ((n_n_mv2msx7n08yx3_t1n).x)) * (n_n_mv2msx7n08yx3_pack01).xy) + (3.0 * (1.0 - ((n_n_mv2msx7n08yx3_t1n).x)) * (1.0 - ((n_n_mv2msx7n08yx3_t1n).x)) * ((n_n_mv2msx7n08yx3_t1n).x) * (n_n_mv2msx7n08yx3_pack01).zw) + (3.0 * (1.0 - ((n_n_mv2msx7n08yx3_t1n).x)) * ((n_n_mv2msx7n08yx3_t1n).x) * ((n_n_mv2msx7n08yx3_t1n).x) * (n_n_mv2msx7n08yx3_pack23).xy) + (((n_n_mv2msx7n08yx3_t1n).x) * ((n_n_mv2msx7n08yx3_t1n).x) * ((n_n_mv2msx7n08yx3_t1n).x) * (n_n_mv2msx7n08yx3_pack23).zw), 0.0, 1.0);
    vec4 n_n_mv2msx7n08yx3_packab = vec4((n_n_mv2msx7n08yx3_pa).xy, (n_n_mv2msx7n08yx3_pb).xy);
    vec4 n_n_mv2msx7n08yx3_segdist = vec4(length(((gl_FragCoord.xy * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y)) - ((n_n_mv2msx7n08yx3_packab).xy + clamp(dot(((gl_FragCoord.xy * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y)) - (n_n_mv2msx7n08yx3_packab).xy, (n_n_mv2msx7n08yx3_packab).zw - (n_n_mv2msx7n08yx3_packab).xy) / max(dot((n_n_mv2msx7n08yx3_packab).zw - (n_n_mv2msx7n08yx3_packab).xy, (n_n_mv2msx7n08yx3_packab).zw - (n_n_mv2msx7n08yx3_packab).xy), 1e-8), 0.0, 1.0) * ((n_n_mv2msx7n08yx3_packab).zw - (n_n_mv2msx7n08yx3_packab).xy))));
    vec4 n_n_mv2msx7n08yx3_best_new = vec4(min((n_n_mv2msx7n08yx3_segdist).x, (vec4(n_n_mv2msx7n08yx3_c_n_best)).x), 0.0, 0.0, 1.0);
    n_n_mv2msx7n08yx3_c_n_best = (n_n_mv2msx7n08yx3_best_new).x;
  }
  vec4 n_n_mv2msx7n9wb2r = vec4(mix(
mix(vec3(0.03, 0.04, 0.06), vec3(0.30, 0.42, 0.60), smoothstep(0.010, 0.0, min(min(length((gl_FragCoord.xy * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y) - ((n_n_mv2msx7n51kbv).xy + clamp(dot((gl_FragCoord.xy * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y) - (n_n_mv2msx7n51kbv).xy, (n_n_mv2msx7n51kbv).zw - (n_n_mv2msx7n51kbv).xy) / max(dot((n_n_mv2msx7n51kbv).zw - (n_n_mv2msx7n51kbv).xy, (n_n_mv2msx7n51kbv).zw - (n_n_mv2msx7n51kbv).xy), 1e-8), 0.0, 1.0) * ((n_n_mv2msx7n51kbv).zw - (n_n_mv2msx7n51kbv).xy))), length((gl_FragCoord.xy * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y) - ((n_n_mv2msx7n51kbv).zw + clamp(dot((gl_FragCoord.xy * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y) - (n_n_mv2msx7n51kbv).zw, (n_n_mv2msx7n3vquy).xy - (n_n_mv2msx7n51kbv).zw) / max(dot((n_n_mv2msx7n3vquy).xy - (n_n_mv2msx7n51kbv).zw, (n_n_mv2msx7n3vquy).xy - (n_n_mv2msx7n51kbv).zw), 1e-8), 0.0, 1.0) * ((n_n_mv2msx7n3vquy).xy - (n_n_mv2msx7n51kbv).zw)))), length((gl_FragCoord.xy * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y) - ((n_n_mv2msx7n3vquy).xy + clamp(dot((gl_FragCoord.xy * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y) - (n_n_mv2msx7n3vquy).xy, (n_n_mv2msx7n3vquy).zw - (n_n_mv2msx7n3vquy).xy) / max(dot((n_n_mv2msx7n3vquy).zw - (n_n_mv2msx7n3vquy).xy, (n_n_mv2msx7n3vquy).zw - (n_n_mv2msx7n3vquy).xy), 1e-8), 0.0, 1.0) * ((n_n_mv2msx7n3vquy).zw - (n_n_mv2msx7n3vquy).xy)))))),
vec3(0.25, 0.95, 1.00), smoothstep(0.011, 0.004, (n_n_mv2msx7n08yx3_c_n_best))
) +
vec3(0.95, 0.75, 0.30) * (smoothstep(0.028, 0.016, length((gl_FragCoord.xy * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y) - (n_n_mv2msx7n51kbv).xy)) + smoothstep(0.028, 0.016, length((gl_FragCoord.xy * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y) - (n_n_mv2msx7n51kbv).zw)) + smoothstep(0.028, 0.016, length((gl_FragCoord.xy * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y) - (n_n_mv2msx7n3vquy).xy)) + smoothstep(0.028, 0.016, length((gl_FragCoord.xy * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y) - (n_n_mv2msx7n3vquy).zw))) +
vec3(1.00, 0.85, 0.40) * smoothstep(0.055, 0.0, length((gl_FragCoord.xy * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y) - ((1.0 - fract(iTime * 0.18)) * (1.0 - fract(iTime * 0.18)) * (1.0 - fract(iTime * 0.18)) * (n_n_mv2msx7n51kbv).xy + 3.0 * (1.0 - fract(iTime * 0.18)) * (1.0 - fract(iTime * 0.18)) * fract(iTime * 0.18) * (n_n_mv2msx7n51kbv).zw + 3.0 * (1.0 - fract(iTime * 0.18)) * fract(iTime * 0.18) * fract(iTime * 0.18) * (n_n_mv2msx7n3vquy).xy + fract(iTime * 0.18) * fract(iTime * 0.18) * fract(iTime * 0.18) * (n_n_mv2msx7n3vquy).zw))), 1.0);
  st_fragColor = n_n_mv2msx7n9wb2r;
}