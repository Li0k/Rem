import { anglesToWorld, projectWorldYXZ, type Target } from './core';

export type VisualTarget = {
  record: Target;
  yaw: number;
  pitch: number;
  baseYaw: number;
  basePitch: number;
  phase: number;
  direction: number;
  speed: number;
  distance: number;
  shape: 'sphere' | 'person';
  slot: number;
  visible: boolean;
};

export type RenderState = {
  yaw: number;
  pitch: number;
  targets: VisualTarget[];
  occluder?: boolean;
};

export function createRenderer(
  canvas: HTMLCanvasElement,
  state: RenderState,
  fov: number,
) {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    depth: false,
    desynchronized: true,
  });
  if (!gl) return null;

  // Both planes are ray-marched in fragment space, so the chamber has no
  // geometry edge and no per-frame allocation as the camera rotates.
  const chamberVertex = `#version 300 es
in vec2 position;
out vec2 uv;
void main(){uv=position*.5+.5;gl_Position=vec4(position,0.,1.);}`;
  const chamberFragment = `#version 300 es
precision highp float;
in vec2 uv;
uniform float yaw;
uniform float pitch;
uniform float fov;
uniform float aspect;
out vec4 color;
float gridLine(vec2 p, float spacing){
  vec2 g=abs(fract(p/spacing)-.5);
  return 1.-smoothstep(.46,.5,max(g.x,g.y));
}
void main(){
  vec2 screen=uv*2.-1.;
  float th=tan(radians(fov)*.5);
  vec3 local=normalize(vec3(screen.x*th,screen.y*th/aspect,-1.));
  float cy=cos(yaw), sy=sin(yaw), cp=cos(pitch), sp=sin(pitch);
  float yawedZ=sp*local.y+cp*local.z;
  vec3 ray=normalize(vec3(cy*local.x+sy*yawedZ,cp*local.y-sp*local.z,-sy*local.x+cy*yawedZ));
  vec3 base=mix(vec3(.80,.84,.88),vec3(.95,.96,.97),smoothstep(.05,1.,1.-uv.y));
  vec3 result=base;
  float hitT=1e9;
  if(ray.y<-.0001){
    float t=(-4.)/ray.y;
    if(t>0.){
      vec3 p=ray*t;
      float line=gridLine(p.xz,3.);
      float fine=gridLine(p.xz,.75)*.24;
      float fade=exp(-t*.032);
      result=mix(result,vec3(.47,.56,.66),min(1.,(line+fine)*fade*.62));
      hitT=t;
    }
  }
  if(ray.z<-.0001){
    float t=(-60.)/ray.z;
    if(t>0. && t<hitT){
      vec3 p=ray*t;
      float line=gridLine(p.xy,3.);
      float fine=gridLine(p.xy,.75)*.24;
      float fade=exp(-t*.020);
      result=mix(result,vec3(.40,.49,.61),min(1.,(line+fine)*fade*.58));
      result+=vec3(.035,.05,.075)*fade;
      hitT=t;
    }
  }
  float vignette=1.-.18*pow(length(screen),2.);
  color=vec4(result*vignette,1.);
}`;
  const targetVertex = `#version 300 es
in vec2 center;
in float pointSize;
in float tone;
out float vTone;
void main(){gl_Position=vec4(center,0.,1.);gl_PointSize=pointSize;vTone=tone;}`;
  const targetFragment = `#version 300 es
precision mediump float;
in float vTone;
out vec4 color;
void main(){
  vec2 p=gl_PointCoord*2.-1.;
  float d=length(p);
  if(d>1.)discard;
  float ring=smoothstep(.72,.96,d);
  if(vTone>1.5){
    color=vec4(vec3(.13,.17,.25)*(1.-.18*d),1.);
    return;
  }
  float light=.76+.24*max(0.,1.-length(p-vec2(-.28,-.28)));
  vec3 base=mix(vec3(.40,.48,.65),vec3(.61,.70,.81),vTone);
  color=vec4(mix(base*light,vec3(.91,.95,.98),ring*.68),1.);
}`;

  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error(
        'Mouse Migration Lab shader compile failed',
        gl.getShaderInfoLog(shader),
      );
    }
    return shader;
  };

  const chamberProgram = gl.createProgram()!;
  const chamberVertexShader = compile(gl.VERTEX_SHADER, chamberVertex);
  const chamberFragmentShader = compile(gl.FRAGMENT_SHADER, chamberFragment);
  gl.attachShader(chamberProgram, chamberVertexShader);
  gl.attachShader(chamberProgram, chamberFragmentShader);
  gl.bindAttribLocation(chamberProgram, 0, 'position');
  gl.linkProgram(chamberProgram);

  const targetProgram = gl.createProgram()!;
  const targetVertexShader = compile(gl.VERTEX_SHADER, targetVertex);
  const targetFragmentShader = compile(gl.FRAGMENT_SHADER, targetFragment);
  gl.attachShader(targetProgram, targetVertexShader);
  gl.attachShader(targetProgram, targetFragmentShader);
  gl.bindAttribLocation(targetProgram, 1, 'center');
  gl.bindAttribLocation(targetProgram, 2, 'pointSize');
  gl.bindAttribLocation(targetProgram, 3, 'tone');
  gl.linkProgram(targetProgram);

  const chamberBuffer = gl.createBuffer()!;
  const buffer = gl.createBuffer()!;
  const chamberPosition = gl.getAttribLocation(chamberProgram, 'position');
  const chamberYaw = gl.getUniformLocation(chamberProgram, 'yaw');
  const chamberPitch = gl.getUniformLocation(chamberProgram, 'pitch');
  const chamberFov = gl.getUniformLocation(chamberProgram, 'fov');
  const chamberAspect = gl.getUniformLocation(chamberProgram, 'aspect');
  const center = gl.getAttribLocation(targetProgram, 'center');
  const pointSize = gl.getAttribLocation(targetProgram, 'pointSize');
  const tone = gl.getAttribLocation(targetProgram, 'tone');
  const targetVertices = new Float32Array(4 * 24);
  const projectedA = new Float32Array(3);
  const worldPoint = new Float32Array(3);
  const fullscreen = new Float32Array([-1, -1, 3, -1, -1, 3]);

  gl.bindBuffer(gl.ARRAY_BUFFER, chamberBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, fullscreen, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(chamberPosition);
  gl.vertexAttribPointer(chamberPosition, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(center);
  gl.enableVertexAttribArray(pointSize);
  gl.enableVertexAttribArray(tone);
  gl.vertexAttribPointer(center, 2, gl.FLOAT, false, 16, 0);
  gl.vertexAttribPointer(pointSize, 1, gl.FLOAT, false, 16, 8);
  gl.vertexAttribPointer(tone, 1, gl.FLOAT, false, 16, 12);
  gl.bufferData(gl.ARRAY_BUFFER, targetVertices.byteLength, gl.STREAM_DRAW);

  const render = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    }
    const aspect = width / height;
    const tanHalfV = Math.tan((fov * Math.PI) / 360) / aspect;

    gl.clearColor(0.02, 0.03, 0.04, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(chamberProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, chamberBuffer);
    gl.uniform1f(chamberYaw, (state.yaw * Math.PI) / 180);
    gl.uniform1f(chamberPitch, (state.pitch * Math.PI) / 180);
    gl.uniform1f(chamberFov, fov);
    gl.uniform1f(chamberAspect, aspect);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);

    let targetCount = 0;
    const point = (
      worldX: number,
      worldY: number,
      worldZ: number,
      worldRadius: number,
      shade: number,
    ) => {
      if (
        !projectWorldYXZ(
          worldX,
          worldY,
          worldZ,
          state.yaw,
          state.pitch,
          fov,
          aspect,
          projectedA,
        ) ||
        Math.abs(projectedA[0]) > 1.3 ||
        Math.abs(projectedA[1]) > 1.3
      ) {
        return;
      }
      const pixelSize = Math.max(
        5,
        (worldRadius / projectedA[2] / tanHalfV) * height,
      );
      let index = targetCount * 4;
      targetVertices[index++] = projectedA[0];
      targetVertices[index++] = projectedA[1];
      targetVertices[index++] = pixelSize;
      targetVertices[index] = shade;
      targetCount += 1;
    };

    if (state.occluder) {
      anglesToWorld(0, 1.8, 13, worldPoint);
      point(worldPoint[0], worldPoint[1], worldPoint[2], 1.75, 2);
    }
    for (const target of state.targets) {
      if (!target.visible) continue;
      anglesToWorld(target.yaw, target.pitch, target.distance, worldPoint);
      const radius =
        Math.tan((target.record.radius * Math.PI) / 180) * target.distance;
      if (target.shape === 'person') {
        point(worldPoint[0], worldPoint[1], worldPoint[2], radius * 0.58, 1);
        point(
          worldPoint[0],
          worldPoint[1] - radius * 1.25,
          worldPoint[2],
          radius * 0.92,
          0.55,
        );
        point(
          worldPoint[0],
          worldPoint[1] - radius * 2.35,
          worldPoint[2],
          radius * 0.72,
          0.35,
        );
      } else {
        point(worldPoint[0], worldPoint[1], worldPoint[2], radius, 0.2);
      }
    }

    gl.bufferSubData(gl.ARRAY_BUFFER, 0, targetVertices, 0, targetCount * 4);
    gl.useProgram(targetProgram);
    gl.drawArrays(gl.POINTS, 0, targetCount);
  };

  const destroy = () => {
    gl.deleteShader(chamberVertexShader);
    gl.deleteShader(chamberFragmentShader);
    gl.deleteShader(targetVertexShader);
    gl.deleteShader(targetFragmentShader);
    gl.deleteBuffer(chamberBuffer);
    gl.deleteBuffer(buffer);
    gl.deleteProgram(chamberProgram);
    gl.deleteProgram(targetProgram);
  };

  return { render, destroy };
}
