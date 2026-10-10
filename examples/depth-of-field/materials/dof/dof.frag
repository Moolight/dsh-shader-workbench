#version 300 es
precision highp float;
precision highp int;

uniform vec3 iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform vec4 iMouse;
uniform vec4 iDate;
uniform sampler2D BufferA;
uniform float uFocus;
uniform float uAperture;

out vec4 st_fragColor;



void main() {
  vec2 n_n_mv2msx5z5w27j = gl_FragCoord.xy / iResolution.xy;
  vec4 n_n_mv2msx5z9vz9t = vec4(clamp(
abs((texture(BufferA, n_n_mv2msx5z5w27j)).w * 12.0 - (uFocus)) * 0.010 * (vec4(uAperture)).x,
0.0, 0.06
));
  vec4 n_n_mv2msx5z9bzxf_seed = vec4(0.0);
  vec4 n_n_mv2msx5z9bzxf_off0 = vec4((vec4((n_n_mv2msx5z5w27j).x, (n_n_mv2msx5z5w27j).y, 0.0, 1.0)).xy + vec2(-1.0, -1.0) * ((n_n_mv2msx5z9vz9t).x), 0.0, 1.0);
  vec4 n_n_mv2msx5z9bzxf_sum0 = (n_n_mv2msx5z9bzxf_seed) + (texture(BufferA, vec2((n_n_mv2msx5z9bzxf_off0).x, (n_n_mv2msx5z9bzxf_off0).y))) * 0.0750;
  vec4 n_n_mv2msx5z9bzxf_off1 = vec4((vec4((n_n_mv2msx5z5w27j).x, (n_n_mv2msx5z5w27j).y, 0.0, 1.0)).xy + vec2(0.0, -1.0) * ((n_n_mv2msx5z9vz9t).x), 0.0, 1.0);
  vec4 n_n_mv2msx5z9bzxf_sum1 = (n_n_mv2msx5z9bzxf_sum0) + (texture(BufferA, vec2((n_n_mv2msx5z9bzxf_off1).x, (n_n_mv2msx5z9bzxf_off1).y))) * 0.1240;
  vec4 n_n_mv2msx5z9bzxf_off2 = vec4((vec4((n_n_mv2msx5z5w27j).x, (n_n_mv2msx5z5w27j).y, 0.0, 1.0)).xy + vec2(1.0, -1.0) * ((n_n_mv2msx5z9vz9t).x), 0.0, 1.0);
  vec4 n_n_mv2msx5z9bzxf_sum2 = (n_n_mv2msx5z9bzxf_sum1) + (texture(BufferA, vec2((n_n_mv2msx5z9bzxf_off2).x, (n_n_mv2msx5z9bzxf_off2).y))) * 0.0750;
  vec4 n_n_mv2msx5z9bzxf_off3 = vec4((vec4((n_n_mv2msx5z5w27j).x, (n_n_mv2msx5z5w27j).y, 0.0, 1.0)).xy + vec2(-1.0, 0.0) * ((n_n_mv2msx5z9vz9t).x), 0.0, 1.0);
  vec4 n_n_mv2msx5z9bzxf_sum3 = (n_n_mv2msx5z9bzxf_sum2) + (texture(BufferA, vec2((n_n_mv2msx5z9bzxf_off3).x, (n_n_mv2msx5z9bzxf_off3).y))) * 0.1240;
  vec4 n_n_mv2msx5z9bzxf_off4 = vec4((vec4((n_n_mv2msx5z5w27j).x, (n_n_mv2msx5z5w27j).y, 0.0, 1.0)).xy + vec2(0.0, 0.0) * ((n_n_mv2msx5z9vz9t).x), 0.0, 1.0);
  vec4 n_n_mv2msx5z9bzxf_sum4 = (n_n_mv2msx5z9bzxf_sum3) + (texture(BufferA, vec2((n_n_mv2msx5z9bzxf_off4).x, (n_n_mv2msx5z9bzxf_off4).y))) * 0.2040;
  vec4 n_n_mv2msx5z9bzxf_off5 = vec4((vec4((n_n_mv2msx5z5w27j).x, (n_n_mv2msx5z5w27j).y, 0.0, 1.0)).xy + vec2(1.0, 0.0) * ((n_n_mv2msx5z9vz9t).x), 0.0, 1.0);
  vec4 n_n_mv2msx5z9bzxf_sum5 = (n_n_mv2msx5z9bzxf_sum4) + (texture(BufferA, vec2((n_n_mv2msx5z9bzxf_off5).x, (n_n_mv2msx5z9bzxf_off5).y))) * 0.1240;
  vec4 n_n_mv2msx5z9bzxf_off6 = vec4((vec4((n_n_mv2msx5z5w27j).x, (n_n_mv2msx5z5w27j).y, 0.0, 1.0)).xy + vec2(-1.0, 1.0) * ((n_n_mv2msx5z9vz9t).x), 0.0, 1.0);
  vec4 n_n_mv2msx5z9bzxf_sum6 = (n_n_mv2msx5z9bzxf_sum5) + (texture(BufferA, vec2((n_n_mv2msx5z9bzxf_off6).x, (n_n_mv2msx5z9bzxf_off6).y))) * 0.0750;
  vec4 n_n_mv2msx5z9bzxf_off7 = vec4((vec4((n_n_mv2msx5z5w27j).x, (n_n_mv2msx5z5w27j).y, 0.0, 1.0)).xy + vec2(0.0, 1.0) * ((n_n_mv2msx5z9vz9t).x), 0.0, 1.0);
  vec4 n_n_mv2msx5z9bzxf_sum7 = (n_n_mv2msx5z9bzxf_sum6) + (texture(BufferA, vec2((n_n_mv2msx5z9bzxf_off7).x, (n_n_mv2msx5z9bzxf_off7).y))) * 0.1240;
  vec4 n_n_mv2msx5z9bzxf_off8 = vec4((vec4((n_n_mv2msx5z5w27j).x, (n_n_mv2msx5z5w27j).y, 0.0, 1.0)).xy + vec2(1.0, 1.0) * ((n_n_mv2msx5z9vz9t).x), 0.0, 1.0);
  vec4 n_n_mv2msx5z9bzxf_sum8 = (n_n_mv2msx5z9bzxf_sum7) + (texture(BufferA, vec2((n_n_mv2msx5z9bzxf_off8).x, (n_n_mv2msx5z9bzxf_off8).y))) * 0.0750;
  vec4 n_n_mv2msx5z9hgfs = vec4(pow((n_n_mv2msx5z9bzxf_sum8).rgb, vec3(0.4545)), 1.0);
  st_fragColor = n_n_mv2msx5z9hgfs;
}