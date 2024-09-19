import mongoose, { Schema, Document } from "mongoose";

export interface ITask extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  contract: {
    slug: string;
    contractAddress: string;
  };
  wallet: {
    address: string;
    privateKey: string;
  };
  selectedMarketplaces: string[];
  running: boolean;
  tags: { name: string; color: string }[];
  selectedTraits: Record<string, string[]>;
  traits: {
    categories: Record<string, string>;
    counts: Record<string, Record<string, number>>;
  };
  outbidOptions: {
    outbid: boolean;
    blurOutbidMargin: number | null;
    openseaOutbidMargin: number | null;
    magicedenOutbidMargin: number | null;
    counterbid: boolean;
  };
  bidPrice: {
    min: number;
    max: number | null;
    minType: "percentage" | "eth";
    maxType: "percentage" | "eth";
  };

  stopOptions: {
    pauseAllBids: boolean;
    stopAllBids: boolean;
    cancelAllBids: boolean;
    minFloorPrice: number;
    maxFloorPrice: number;
    minTraitPrice: number;
    maxTraitPrice: number;
    maxPurchase: number;
    triggerStopOptions: boolean;
  };
  bidDuration: number;
  tokenIds: number[]
}

const TaskSchema: Schema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    contract: {
      slug: { type: String, required: true },
      contractAddress: { type: String, required: true },
    },
    wallet: {
      address: { type: String, required: true },
      privateKey: { type: String, required: true },
    },
    selectedMarketplaces: { type: [String], required: true },
    running: { type: Boolean, default: false },
    tags: [{ name: String, color: String }],
    selectedTraits: { type: Schema.Types.Mixed },
    traits: {
      categories: { type: Schema.Types.Mixed },
      counts: { type: Schema.Types.Mixed },
    },
    outbidOptions: {
      outbid: { type: Boolean, default: false },
      blurOutbidMargin: { type: Number, default: null },
      openseaOutbidMargin: { type: Number, default: null },
      magicedenOutbidMargin: { type: Number, default: null },
      counterbid: { type: Boolean, default: false },
    },
    bidPrice: {
      min: { type: Number, required: true },
      max: { type: Number, required: false, default: null },
      minType: { type: String, enum: ["percentage", "eth"], required: true },
      maxType: { type: String, enum: ["percentage", "eth"], required: true },
    },
    stopOptions: {
      minFloorPrice: { type: Number, required: true },
      maxFloorPrice: { type: Number, required: true },
      minTraitPrice: { type: Number, required: true },
      maxTraitPrice: { type: Number, required: true },
      maxPurchase: { type: Number, required: true },
      pauseAllBids: { type: Boolean, default: false },
      stopAllBids: { type: Boolean, default: false },
      cancelAllBids: { type: Boolean, default: false },
      triggerStopOptions: { type: Boolean, default: false },
    },
    bidDuration: { type: Number, required: false, default: 900 },
    tokenIds: { type: [Number], default: [] }, // Add this line

  },
  { timestamps: true }
);

const Task = mongoose.model<ITask>("Task", TaskSchema);
export default Task;
