#version 300 es
precision highp float;
precision highp int;

uniform vec3 iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform vec4 iMouse;
uniform vec4 iDate;
uniform sampler2D BufferA;

out vec4 st_fragColor;



void main() {
  vec4 n_n_mv2lw2rg846fx = vec4(9.0);
  vec2 n_n_mv2lw2rg83arm = gl_FragCoord.xy / iResolution.xy;
  vec4 n_n_mv2lw2rg2f8h4 = vec4(0.0);
  vec4 n_n_mv2lw2rg754d7 = vec4(min(((n_n_mv2lw2rg846fx).x), abs(length((((vec4((n_n_mv2lw2rg83arm).x, (n_n_mv2lw2rg83arm).y, 0.0, 1.0)).xy * 2.0 - 1.0) * vec2(iResolution.x / iResolution.y, 1.0)) - (n_n_mv2lw2rg2f8h4).xy) - 0.455882)));
  float n_n_mv2lw2rg74yc3 = iTime * 0.12;
  vec4 n_n_mv2lw2rg2d1bm = vec4((n_n_mv2lw2rg2f8h4).xy + 0.455882 * vec2(cos(6.283185307179586 * -1.0 * (vec4(n_n_mv2lw2rg74yc3)).x + 1.570796), sin(6.283185307179586 * -1.0 * (vec4(n_n_mv2lw2rg74yc3)).x + 1.570796)), 0.0, 1.0);
  vec4 n_n_mv2lw2rg0886s = vec4(min(((n_n_mv2lw2rg754d7).x), abs(length((((vec4((n_n_mv2lw2rg83arm).x, (n_n_mv2lw2rg83arm).y, 0.0, 1.0)).xy * 2.0 - 1.0) * vec2(iResolution.x / iResolution.y, 1.0)) - (n_n_mv2lw2rg2d1bm).xy) - 0.109412)));
  vec4 n_n_mv2lw2rg67mqq = vec4((n_n_mv2lw2rg2d1bm).xy + 0.109412 * vec2(cos(6.283185307179586 * -3.0 * (vec4(n_n_mv2lw2rg74yc3)).x + -1.570796), sin(6.283185307179586 * -3.0 * (vec4(n_n_mv2lw2rg74yc3)).x + -1.570796)), 0.0, 1.0);
  vec4 n_n_mv2lw2rg2b209 = vec4(min(((n_n_mv2lw2rg0886s).x), abs(length((((vec4((n_n_mv2lw2rg83arm).x, (n_n_mv2lw2rg83arm).y, 0.0, 1.0)).xy * 2.0 - 1.0) * vec2(iResolution.x / iResolution.y, 1.0)) - (n_n_mv2lw2rg67mqq).xy) - 0.091177)));
  vec4 n_n_mv2lw2rg36nb5 = vec4((n_n_mv2lw2rg67mqq).xy + 0.091177 * vec2(cos(6.283185307179586 * 2.0 * (vec4(n_n_mv2lw2rg74yc3)).x + -1.570796), sin(6.283185307179586 * 2.0 * (vec4(n_n_mv2lw2rg74yc3)).x + -1.570796)), 0.0, 1.0);
  vec4 n_n_mv2lw2rg269aq = vec4(min(((n_n_mv2lw2rg2b209).x), abs(length((((vec4((n_n_mv2lw2rg83arm).x, (n_n_mv2lw2rg83arm).y, 0.0, 1.0)).xy * 2.0 - 1.0) * vec2(iResolution.x / iResolution.y, 1.0)) - (n_n_mv2lw2rg36nb5).xy) - 0.091177)));
  vec4 n_n_mv2lw2rg4c2qe = vec4((n_n_mv2lw2rg36nb5).xy + 0.091177 * vec2(cos(6.283185307179586 * -2.0 * (vec4(n_n_mv2lw2rg74yc3)).x + -1.570796), sin(6.283185307179586 * -2.0 * (vec4(n_n_mv2lw2rg74yc3)).x + -1.570796)), 0.0, 1.0);
  vec4 n_n_mv2lw2rg1p4uv = vec4(min(((n_n_mv2lw2rg269aq).x), abs(length((((vec4((n_n_mv2lw2rg83arm).x, (n_n_mv2lw2rg83arm).y, 0.0, 1.0)).xy * 2.0 - 1.0) * vec2(iResolution.x / iResolution.y, 1.0)) - (n_n_mv2lw2rg4c2qe).xy) - 0.036471)));
  vec4 n_n_mv2lw2rg18ber = vec4((n_n_mv2lw2rg4c2qe).xy + 0.036471 * vec2(cos(6.283185307179586 * 3.0 * (vec4(n_n_mv2lw2rg74yc3)).x + 1.570796), sin(6.283185307179586 * 3.0 * (vec4(n_n_mv2lw2rg74yc3)).x + 1.570796)), 0.0, 1.0);
  vec4 n_n_mv2lw2rg1ya85 = vec4(min(((n_n_mv2lw2rg1p4uv).x), abs(length((((vec4((n_n_mv2lw2rg83arm).x, (n_n_mv2lw2rg83arm).y, 0.0, 1.0)).xy * 2.0 - 1.0) * vec2(iResolution.x / iResolution.y, 1.0)) - (n_n_mv2lw2rg18ber).xy) - 0.018235)));
  vec4 n_n_mv2lw2rg9kslt = vec4(smoothstep(0.0045, 0.0, (n_n_mv2lw2rg1ya85).x));
  vec4 n_n_mv2lw2rg7fjkl = vec4(0.0);
  vec4 n_n_mv2lw2rg6j04b = vec4(max(((n_n_mv2lw2rg7fjkl).x), smoothstep(0.016, 0.0, length((((vec4((n_n_mv2lw2rg83arm).x, (n_n_mv2lw2rg83arm).y, 0.0, 1.0)).xy * 2.0 - 1.0) * vec2(iResolution.x / iResolution.y, 1.0)) - (n_n_mv2lw2rg2d1bm).xy))));
  vec4 n_n_mv2lw2rg6zg0b = vec4(max(((n_n_mv2lw2rg6j04b).x), smoothstep(0.016, 0.0, length((((vec4((n_n_mv2lw2rg83arm).x, (n_n_mv2lw2rg83arm).y, 0.0, 1.0)).xy * 2.0 - 1.0) * vec2(iResolution.x / iResolution.y, 1.0)) - (n_n_mv2lw2rg67mqq).xy))));
  vec4 n_n_mv2lw2rg0hk58 = vec4(max(((n_n_mv2lw2rg6zg0b).x), smoothstep(0.016, 0.0, length((((vec4((n_n_mv2lw2rg83arm).x, (n_n_mv2lw2rg83arm).y, 0.0, 1.0)).xy * 2.0 - 1.0) * vec2(iResolution.x / iResolution.y, 1.0)) - (n_n_mv2lw2rg36nb5).xy))));
  vec4 n_n_mv2lw2rg8u98a = vec4(max(((n_n_mv2lw2rg0hk58).x), smoothstep(0.016, 0.0, length((((vec4((n_n_mv2lw2rg83arm).x, (n_n_mv2lw2rg83arm).y, 0.0, 1.0)).xy * 2.0 - 1.0) * vec2(iResolution.x / iResolution.y, 1.0)) - (n_n_mv2lw2rg4c2qe).xy))));
  vec4 n_n_mv2lw2rg08s2w = vec4(max(((n_n_mv2lw2rg8u98a).x), smoothstep(0.016, 0.0, length((((vec4((n_n_mv2lw2rg83arm).x, (n_n_mv2lw2rg83arm).y, 0.0, 1.0)).xy * 2.0 - 1.0) * vec2(iResolution.x / iResolution.y, 1.0)) - (n_n_mv2lw2rg18ber).xy))));
  vec4 n_n_mv2lw2rg6sbrk = vec4((n_n_mv2lw2rg18ber).xy + 0.018235 * vec2(cos(6.283185307179586 * -4.0 * (vec4(n_n_mv2lw2rg74yc3)).x + -1.570796), sin(6.283185307179586 * -4.0 * (vec4(n_n_mv2lw2rg74yc3)).x + -1.570796)), 0.0, 1.0);
  vec4 n_n_mv2lw2rg50rwx = vec4(max(((n_n_mv2lw2rg08s2w).x), smoothstep(0.016, 0.0, length((((vec4((n_n_mv2lw2rg83arm).x, (n_n_mv2lw2rg83arm).y, 0.0, 1.0)).xy * 2.0 - 1.0) * vec2(iResolution.x / iResolution.y, 1.0)) - (n_n_mv2lw2rg6sbrk).xy))));
  vec4 n_n_mv2lw2rg5b96f = vec4((n_n_mv2lw2rg6sbrk).xy + 0.018235 * vec2(cos(6.283185307179586 * 1.0 * (vec4(n_n_mv2lw2rg74yc3)).x + 1.570796), sin(6.283185307179586 * 1.0 * (vec4(n_n_mv2lw2rg74yc3)).x + 1.570796)), 0.0, 1.0);
  vec4 n_n_mv2lw2rg9di73 = vec4(max(((n_n_mv2lw2rg50rwx).x), smoothstep(0.016, 0.0, length((((vec4((n_n_mv2lw2rg83arm).x, (n_n_mv2lw2rg83arm).y, 0.0, 1.0)).xy * 2.0 - 1.0) * vec2(iResolution.x / iResolution.y, 1.0)) - (n_n_mv2lw2rg5b96f).xy))));
  vec4 n_n_mv2lw2rg3maib = vec4((n_n_mv2lw2rg5b96f).xy + 0.018235 * vec2(cos(6.283185307179586 * 4.0 * (vec4(n_n_mv2lw2rg74yc3)).x + -1.570796), sin(6.283185307179586 * 4.0 * (vec4(n_n_mv2lw2rg74yc3)).x + -1.570796)), 0.0, 1.0);
  vec4 n_n_mv2lw2rg5vvl9 = vec4(max(((n_n_mv2lw2rg9di73).x), smoothstep(0.016, 0.0, length((((vec4((n_n_mv2lw2rg83arm).x, (n_n_mv2lw2rg83arm).y, 0.0, 1.0)).xy * 2.0 - 1.0) * vec2(iResolution.x / iResolution.y, 1.0)) - (n_n_mv2lw2rg3maib).xy))));
  vec4 n_n_mv2lw2rg1t0pc = vec4(max((n_n_mv2lw2rg9kslt).x, (n_n_mv2lw2rg5vvl9).x));
  vec4 n_n_mv2lw2rg2nz7c = vec4((n_n_mv2lw2rg1t0pc).x, (n_n_mv2lw2rg3maib).xy, 0.0);
  vec4 n_n_mv2lw2rg92dla = vec4(max((n_n_mv2lw2rg2nz7c).x, (texture(BufferA, n_n_mv2lw2rg83arm)).x * 0.90), (n_n_mv2lw2rg2nz7c).yz, 0.0);
  vec4 n_n_mv2lw2rg4m5vo = vec4(mix(
mix(vec3(0.02, 0.025, 0.04), vec3(0.95, 0.78, 0.35), (n_n_mv2lw2rg92dla).x * 0.62),
vec3(1.00, 0.88, 0.45), smoothstep(0.030, 0.0, length((((vec4((n_n_mv2lw2rg83arm).x, (n_n_mv2lw2rg83arm).y, 0.0, 1.0)).xy * 2.0 - 1.0) * vec2(iResolution.x / iResolution.y, 1.0)) - (n_n_mv2lw2rg92dla).yz))
), 1.0);
  st_fragColor = n_n_mv2lw2rg4m5vo;
}