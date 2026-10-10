#version 300 es
precision highp float;
precision highp int;

uniform vec3 iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform vec4 iMouse;
uniform vec4 iDate;
uniform sampler2D BufferA;
uniform float uRadius;

out vec4 st_fragColor;



void main() {
  vec2 n_n_mv2msx442lu96 = gl_FragCoord.xy / iResolution.xy;
  vec4 n_n_mv2msx442fxow_seed = vec4(0.0);
  vec4 n_n_mv2msx442fxow_off0 = vec4((vec4((n_n_mv2msx442lu96).x, (n_n_mv2msx442lu96).y, 0.0, 1.0)).xy + vec2(-1.0, -1.0) * (uRadius), 0.0, 1.0);
  vec4 n_n_mv2msx442fxow_sum0 = (n_n_mv2msx442fxow_seed) + (texture(BufferA, vec2((n_n_mv2msx442fxow_off0).x, (n_n_mv2msx442fxow_off0).y))) * 0.0750;
  vec4 n_n_mv2msx442fxow_off1 = vec4((vec4((n_n_mv2msx442lu96).x, (n_n_mv2msx442lu96).y, 0.0, 1.0)).xy + vec2(0.0, -1.0) * (uRadius), 0.0, 1.0);
  vec4 n_n_mv2msx442fxow_sum1 = (n_n_mv2msx442fxow_sum0) + (texture(BufferA, vec2((n_n_mv2msx442fxow_off1).x, (n_n_mv2msx442fxow_off1).y))) * 0.1240;
  vec4 n_n_mv2msx442fxow_off2 = vec4((vec4((n_n_mv2msx442lu96).x, (n_n_mv2msx442lu96).y, 0.0, 1.0)).xy + vec2(1.0, -1.0) * (uRadius), 0.0, 1.0);
  vec4 n_n_mv2msx442fxow_sum2 = (n_n_mv2msx442fxow_sum1) + (texture(BufferA, vec2((n_n_mv2msx442fxow_off2).x, (n_n_mv2msx442fxow_off2).y))) * 0.0750;
  vec4 n_n_mv2msx442fxow_off3 = vec4((vec4((n_n_mv2msx442lu96).x, (n_n_mv2msx442lu96).y, 0.0, 1.0)).xy + vec2(-1.0, 0.0) * (uRadius), 0.0, 1.0);
  vec4 n_n_mv2msx442fxow_sum3 = (n_n_mv2msx442fxow_sum2) + (texture(BufferA, vec2((n_n_mv2msx442fxow_off3).x, (n_n_mv2msx442fxow_off3).y))) * 0.1240;
  vec4 n_n_mv2msx442fxow_off4 = vec4((vec4((n_n_mv2msx442lu96).x, (n_n_mv2msx442lu96).y, 0.0, 1.0)).xy + vec2(0.0, 0.0) * (uRadius), 0.0, 1.0);
  vec4 n_n_mv2msx442fxow_sum4 = (n_n_mv2msx442fxow_sum3) + (texture(BufferA, vec2((n_n_mv2msx442fxow_off4).x, (n_n_mv2msx442fxow_off4).y))) * 0.2040;
  vec4 n_n_mv2msx442fxow_off5 = vec4((vec4((n_n_mv2msx442lu96).x, (n_n_mv2msx442lu96).y, 0.0, 1.0)).xy + vec2(1.0, 0.0) * (uRadius), 0.0, 1.0);
  vec4 n_n_mv2msx442fxow_sum5 = (n_n_mv2msx442fxow_sum4) + (texture(BufferA, vec2((n_n_mv2msx442fxow_off5).x, (n_n_mv2msx442fxow_off5).y))) * 0.1240;
  vec4 n_n_mv2msx442fxow_off6 = vec4((vec4((n_n_mv2msx442lu96).x, (n_n_mv2msx442lu96).y, 0.0, 1.0)).xy + vec2(-1.0, 1.0) * (uRadius), 0.0, 1.0);
  vec4 n_n_mv2msx442fxow_sum6 = (n_n_mv2msx442fxow_sum5) + (texture(BufferA, vec2((n_n_mv2msx442fxow_off6).x, (n_n_mv2msx442fxow_off6).y))) * 0.0750;
  vec4 n_n_mv2msx442fxow_off7 = vec4((vec4((n_n_mv2msx442lu96).x, (n_n_mv2msx442lu96).y, 0.0, 1.0)).xy + vec2(0.0, 1.0) * (uRadius), 0.0, 1.0);
  vec4 n_n_mv2msx442fxow_sum7 = (n_n_mv2msx442fxow_sum6) + (texture(BufferA, vec2((n_n_mv2msx442fxow_off7).x, (n_n_mv2msx442fxow_off7).y))) * 0.1240;
  vec4 n_n_mv2msx442fxow_off8 = vec4((vec4((n_n_mv2msx442lu96).x, (n_n_mv2msx442lu96).y, 0.0, 1.0)).xy + vec2(1.0, 1.0) * (uRadius), 0.0, 1.0);
  vec4 n_n_mv2msx442fxow_sum8 = (n_n_mv2msx442fxow_sum7) + (texture(BufferA, vec2((n_n_mv2msx442fxow_off8).x, (n_n_mv2msx442fxow_off8).y))) * 0.0750;
  vec4 n_n_mv2msx442rf62 = vec4(pow((n_n_mv2msx442fxow_sum8).rgb, vec3(0.4545)), 1.0);
  st_fragColor = n_n_mv2msx442rf62;
}