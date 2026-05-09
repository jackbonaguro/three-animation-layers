import { Vector2 } from "three";
import { AnimationLayerAction } from "./AnimationLayerAction";

export class AnimationBlendTree2D {
    actions: AnimationLayerAction[];
    thresholds: Vector2[];
    pipj: (Vector2 | null)[][];
    /**
     * 
     * @param {AnimationAction[]} actions 
     * @param {(Vector2 | null)[]} thresholds An array of x,y pairs corresponding to the thresholds for each action
     */
    constructor(actions: AnimationLayerAction[], thresholds: Vector2[]){
        this.actions=actions;
        /** @type {Vector2[]} */
        this.thresholds=thresholds;
        /** @type {Vector2[][]} */
        this.pipj=[];
        this.calculateInfluenceVectors();
        actions.forEach((action, i) => {
            if (i > 0) {
                action.syncWith(this.actions[i - 1]);
            }
            action.play();
            if(this.thresholds[i].x === 0 && this.thresholds[i].y === 0){
                this.thresholds[i].x = Number.EPSILON;
            }
        })
    }
    calculateInfluenceVectors(){
        this.pipj=this.thresholds.map((pi,i)=>{
            return this.thresholds.map((pj,j)=>{
                if(i===j) return null;
                return this._convertToInfluenceVector(pi,pj);
            });
        });
        
    }
    /**
     * 
     * @param {Vector2} pi 
     * @param {Vector2} pj 
     * @returns 
     */
    _convertToInfluenceVector(pi: Vector2, pj: Vector2){
        const x=pj.length()-pi.length();
        const y = signedAngleTo(pj,pi) * 2;
        return new Vector2(x,y);
    }
    /**
     * 
     * @param {Vector2} value 
     * @param {number} i 
     */
    _findInfluence(value: Vector2, i: number){
        const pip=this._convertToInfluenceVector(this.thresholds[i],value);
        let hip=Number.MAX_VALUE;
        this.thresholds.forEach((t,j)=>{
            if(i===j) return;
            const pipj=this.pipj[i][j];
            const h=1-(pip.dot(pipj!)/(pipj!.length()*pipj!.length()));
            hip=Math.min(hip,h);
        });
        return hip;
    }
    /**
     * 
     * @param {Vector2} value 
     */
    updateWeights(value: Vector2){
        // Clamp each clip's influence to >=0 BEFORE summing. The original
        // version summed raw influences (which can be negative for far-side
        // clips) and then clamped each weight to [0,1] after dividing, which
        // masks weights blowing past 1 when the denominator is small/negative.
        let sum=0;
        const hips=this.thresholds.map((t,i)=>{
            const infl = Math.max(0, this._findInfluence(value,i));
            sum+=infl;
            return infl;
        });
        if(sum<=0) return;
        this.actions.forEach((action,i)=>{
            action.setEffectiveWeight(hips[i]/sum);
        });
    }
}



/**
 * 
 * @param {Vector2} u 
 * @param {Vector2} v 
 * @returns 
 */
function signedAngleTo(u: Vector2, v: Vector2) {
    // Signed angle from u to v in the XY plane, range (-pi, pi]
    return Math.atan2(u.x * v.y - u.y * v.x, u.dot(v));
}
